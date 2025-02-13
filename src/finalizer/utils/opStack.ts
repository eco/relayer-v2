import assert from "assert";
import { groupBy } from "lodash";
import * as optimismSDK from "@eth-optimism/sdk";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { L1Token, TokensBridged } from "../../interfaces";
import {
  BigNumber,
  convertFromWei,
  getCachedProvider,
  getNetworkName,
  getUniqueLogIndex,
  groupObjectCountsByProp,
  Wallet,
  winston,
} from "../../utils";
import { Multicall2Call } from "../../common";
import { FinalizerPromise, Withdrawal } from "../types";

interface CrossChainMessageWithEvent {
  event: TokensBridged;
  message: optimismSDK.MessageLike;
}

interface CrossChainMessageWithStatus extends CrossChainMessageWithEvent {
  status: string;
  logIndex: number;
}

type OVM_CHAIN_ID = 10 | 8453;
type OVM_CROSS_CHAIN_MESSENGER = optimismSDK.CrossChainMessenger;

export async function opStackFinalizer(
  logger: winston.Logger,
  signer: Wallet,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient,
  latestBlockToFinalize: number
): Promise<FinalizerPromise> {
  const { chainId } = spokePoolClient;
  assert(isOVMChainId(chainId), `Unsupported OP Stack chain ID: ${chainId}`);
  const networkName = getNetworkName(chainId);

  const crossChainMessenger = getOptimismClient(chainId, signer);

  // Sort tokensBridged events by their age. Submit proofs for recent events, and withdrawals for older events.
  const earliestBlockToProve = latestBlockToFinalize + 1;
  const { recentTokensBridgedEvents = [], olderTokensBridgedEvents = [] } = groupBy(
    spokePoolClient.getTokensBridged(),
    (e) => (e.blockNumber >= earliestBlockToProve ? "recentTokensBridgedEvents" : "olderTokensBridgedEvents")
  );

  // First submit proofs for any newly withdrawn tokens. You can submit proofs for any withdrawals that have been
  // snapshotted on L1, so it takes roughly 1 hour from the withdrawal time
  logger.debug({
    at: `Finalizer#${networkName}Finalizer`,
    message: `Earliest TokensBridged block to attempt to submit proofs for ${networkName}`,
    earliestBlockToProve,
  });

  const proofs = await multicallOptimismL1Proofs(
    chainId,
    recentTokensBridgedEvents,
    crossChainMessenger,
    hubPoolClient,
    logger
  );

  // Next finalize withdrawals that have passed challenge period.
  // Skip events that are likely not past the seven day challenge period.
  logger.debug({
    at: "Finalizer",
    message: `Oldest TokensBridged block to attempt to finalize for ${networkName}`,
    latestBlockToFinalize,
  });

  const finalizations = await multicallOptimismFinalizations(
    chainId,
    olderTokensBridgedEvents,
    crossChainMessenger,
    hubPoolClient,
    logger
  );

  const callData = [...proofs.callData, ...finalizations.callData];
  const withdrawals = [...proofs.withdrawals, ...finalizations.withdrawals];

  return { callData, withdrawals };
}

function isOVMChainId(chainId: number): chainId is OVM_CHAIN_ID {
  return [10, 8453].includes(chainId);
}

function getOptimismClient(chainId: OVM_CHAIN_ID, hubSigner: Wallet): OVM_CROSS_CHAIN_MESSENGER {
  return new optimismSDK.CrossChainMessenger({
    bedrock: true,
    l1ChainId: 1,
    l2ChainId: chainId,
    l1SignerOrProvider: hubSigner.connect(getCachedProvider(1, true)),
    l2SignerOrProvider: hubSigner.connect(getCachedProvider(chainId, true)),
  });
}

async function getCrossChainMessages(
  _chainId: OVM_CHAIN_ID,
  tokensBridged: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithEvent[]> {
  // For each token bridge event, store a unique log index for the event within the optimism transaction hash.
  // This is important for bridge transactions containing multiple events.
  const logIndexesForMessage = getUniqueLogIndex(tokensBridged);

  return (
    await Promise.all(
      tokensBridged.map(
        async (l2Event, i) =>
          (
            await crossChainMessenger.getMessagesByTransaction(l2Event.transactionHash, {
              direction: optimismSDK.MessageDirection.L2_TO_L1,
            })
          )[logIndexesForMessage[i]]
      )
    )
  ).map((message, i) => {
    return {
      message,
      event: tokensBridged[i],
    };
  });
}

async function getMessageStatuses(
  _chainId: OVM_CHAIN_ID,
  crossChainMessages: CrossChainMessageWithEvent[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
  // For each token bridge event, store a unique log index for the event within the arbitrum transaction hash.
  // This is important for bridge transactions containing multiple events.
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of crossChainMessages.map((m) => m.event)) {
    uniqueTokenhashes[event.transactionHash] = uniqueTokenhashes[event.transactionHash] ?? 0;
    const logIndex = uniqueTokenhashes[event.transactionHash];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] += 1;
  }

  const statuses = await Promise.all(
    crossChainMessages.map((message, i) => {
      return (crossChainMessenger as optimismSDK.CrossChainMessenger).getMessageStatus(
        message.message as optimismSDK.MessageLike,
        logIndexesForMessage[i]
      );
    })
  );
  return statuses.map((status, i) => {
    return {
      status: optimismSDK.MessageStatus[status],
      message: crossChainMessages[i].message,
      event: crossChainMessages[i].event,
      logIndex: logIndexesForMessage[i],
    };
  });
}

async function getOptimismFinalizableMessages(
  chainId: OVM_CHAIN_ID,
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER
): Promise<CrossChainMessageWithStatus[]> {
  const crossChainMessages = await getCrossChainMessages(chainId, tokensBridged, crossChainMessenger);
  // Temporary fix until we're well past the bedrock upgrade. Remove non Bedrock messages.
  // Example way to detect whether message is bedrock:
  // - https://github.com/ethereum-optimism/optimism/blob/develop/packages/sdk/src/cross-chain-messenger.ts#L332
  // - https://github.com/ethereum-optimism/optimism/blob/develop/packages/core-utils/src/optimism/encoding.ts#L34
  const bedrockMessages = (
    await Promise.all(
      crossChainMessages.map(async (crossChainMessage) => {
        const resolved = await crossChainMessenger.toCrossChainMessage(crossChainMessage.message);
        const version = BigNumber.from(resolved.messageNonce).shr(240).toNumber();
        if (version !== 1) {
          return undefined;
        } else {
          return crossChainMessage;
        }
      })
    )
  ).filter((m) => m !== undefined);
  const messageStatuses = await getMessageStatuses(chainId, bedrockMessages, crossChainMessenger);
  logger.debug({
    at: `${getNetworkName(chainId)}Finalizer`,
    message: `${getNetworkName(chainId)} message statuses`,
    statusesGrouped: groupObjectCountsByProp(messageStatuses, (message: CrossChainMessageWithStatus) => message.status),
  });
  return messageStatuses.filter(
    (message) =>
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY] ||
      message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_TO_PROVE]
  );
}

function getL1TokenInfoForOptimismToken(chainId: OVM_CHAIN_ID, hubPoolClient: HubPoolClient, l2Token: string): L1Token {
  return hubPoolClient.getL1TokenInfoForL2Token(
    SpokePoolClient.getExecutedRefundLeafL2Token(chainId, l2Token),
    chainId
  );
}

async function finalizeOptimismMessage(
  _chainId: OVM_CHAIN_ID,
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  message: CrossChainMessageWithStatus,
  logIndex = 0
): Promise<Multicall2Call> {
  const callData = await (crossChainMessenger as optimismSDK.CrossChainMessenger).populateTransaction.finalizeMessage(
    message.message as optimismSDK.MessageLike,
    undefined,
    logIndex
  );
  return {
    callData: callData.data,
    target: callData.to,
  };
}

async function proveOptimismMessage(
  _chainId: OVM_CHAIN_ID,
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  message: CrossChainMessageWithStatus,
  logIndex = 0
): Promise<Multicall2Call> {
  const callData = await (crossChainMessenger as optimismSDK.CrossChainMessenger).populateTransaction.proveMessage(
    message.message as optimismSDK.MessageLike,
    undefined,
    logIndex
  );
  return {
    callData: callData.data,
    target: callData.to,
  };
}

async function multicallOptimismFinalizations(
  chainId: OVM_CHAIN_ID,
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const finalizableMessages = (
    await getOptimismFinalizableMessages(chainId, logger, tokensBridgedEvents, crossChainMessenger)
  ).filter((message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_FOR_RELAY]);
  const callData = await Promise.all(
    finalizableMessages.map((message) =>
      finalizeOptimismMessage(chainId, crossChainMessenger, message, message.logIndex)
    )
  );
  const withdrawals = finalizableMessages.map((message) => {
    const l1TokenInfo = getL1TokenInfoForOptimismToken(chainId, hubPoolClient, message.event.l2TokenAddress);
    const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), l1TokenInfo.decimals);
    const withdrawal: Withdrawal = {
      l2ChainId: chainId,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
      type: "withdrawal",
    };
    return withdrawal;
  });

  return {
    callData,
    withdrawals,
  };
}

async function multicallOptimismL1Proofs(
  chainId: OVM_CHAIN_ID,
  tokensBridgedEvents: TokensBridged[],
  crossChainMessenger: OVM_CROSS_CHAIN_MESSENGER,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<{ callData: Multicall2Call[]; withdrawals: Withdrawal[] }> {
  const provableMessages = (
    await getOptimismFinalizableMessages(chainId, logger, tokensBridgedEvents, crossChainMessenger)
  ).filter((message) => message.status === optimismSDK.MessageStatus[optimismSDK.MessageStatus.READY_TO_PROVE]);
  const callData = await Promise.all(
    provableMessages.map((message) => proveOptimismMessage(chainId, crossChainMessenger, message, message.logIndex))
  );
  const withdrawals = provableMessages.map((message) => {
    const l1TokenInfo = getL1TokenInfoForOptimismToken(chainId, hubPoolClient, message.event.l2TokenAddress);
    const amountFromWei = convertFromWei(message.event.amountToReturn.toString(), l1TokenInfo.decimals);
    const proof: Withdrawal = {
      l2ChainId: chainId,
      l1TokenSymbol: l1TokenInfo.symbol,
      amount: amountFromWei,
      type: "proof",
    };
    return proof;
  });

  return {
    callData,
    withdrawals,
  };
}
