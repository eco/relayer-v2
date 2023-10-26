import assert from "assert";
import { Contract, ethers, utils as ethersUtils } from "ethers";
import readline from "readline";
import * as contracts from "@across-protocol/contracts-v2";
import { getDeployedContract, getNodeUrlList } from "../src/utils";

export type ERC20 = {
  address: string;
  decimals: number;
  symbol: string;
};

export const testChains = [5, 280, 80001, 421613];
export const chains = [1, 10, 137, 324, 8453, 42161];

// Public RPC endpoints to be used if preferred providers are not defined in the environment.
const fallbackProviders: { [chainId: number]: string } = {
  1: "https://eth.llamarpc.com",
  5: "https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
};

async function askQuestion(query: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

export async function askYesNoQuestion(query: string): Promise<boolean> {
  const ans = (await askQuestion(`${query} (y/n) `)) as string;
  if (ans.toLowerCase() === "y") {
    return true;
  }
  if (ans.toLowerCase() === "n") {
    return false;
  }
  return askYesNoQuestion(query);
}

/**
 * Resolves an ERC20 type from a chain ID, and symbol or address.
 * @param token The address or symbol of the token to resolve.
 * @param chainId The chain ID to resolve the token on.
 * @returns The ERC20 attributes of the token.
 */
export function resolveToken(token: string, chainId: number): ERC20 {
  // `token` may be an address or a symbol. Normalise it to a symbol for easy lookup.
  const symbol = !ethersUtils.isAddress(token)
    ? token.toUpperCase()
    : Object.values(contracts.TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === token)?.symbol;

  const _token = contracts.TOKEN_SYMBOLS_MAP[symbol];
  if (_token === undefined) {
    throw new Error(`Token ${token} on chain ID ${chainId} unrecognised`);
  }

  return {
    address: _token.addresses[chainId],
    decimals: _token.decimals,
    symbol: _token.symbol,
  };
}

/**
 * @description Verify that an array of chain IDs have known Across deployments.
 * @dev This function does not detect if the test and production chain IDs have been mixed.
 * @param chainIds Array of chain IDs to validate.
 * @returns True if all chainIds are known.
 */
export function validateChainIds(chainIds: number[]): boolean {
  const knownChainIds = [...chains, ...testChains];
  return chainIds.every((chainId) => {
    const ok = knownChainIds.includes(chainId);
    if (!ok) {
      console.log(`Invalid chain ID: ${chainId}`);
    }
    return ok;
  });
}

/**
 * @description Resolve a default provider URL.
 * @param chainId Chain ID for the provider to select.
 * @returns URL of the provider endpoint.
 */
export function getProviderUrl(chainId: number): string {
  try {
    return getNodeUrlList(chainId, 1)[0];
  } catch {
    return fallbackProviders[chainId];
  }
}

/**
 * @description For a SpokePool chain ID, resolve its corresponding HubPool chain ID.
 * @param spokeChainId Chain ID of the SpokePool.
 * @returns Chain ID for the corresponding HubPool.
 */
export function resolveHubChainId(spokeChainId: number): number {
  if (chains.includes(spokeChainId)) {
    return 1;
  }

  assert(testChains.includes(spokeChainId), `Unsupported SpokePool chain ID: ${spokeChainId}`);
  return 5;
}

/**
 * @description Instantiate an ethers Contract instance.
 * @param chainId Chain ID for the contract deployment.
 * @param contractName Name of the deployed contract.
 * @returns ethers Contract instance.
 */
export async function getContract(chainId: number, contractName: string): Promise<Contract> {
  const contract = getDeployedContract(contractName, chainId);
  const provider = new ethers.providers.StaticJsonRpcProvider(getProviderUrl(chainId));
  return contract.connect(provider);
}

/**
 * @description Instantiate an Across SpokePool contract instance.
 * @param chainId Chain ID for the SpokePool deployment.
 * @returns SpokePool contract instance.
 */
export async function getSpokePoolContract(chainId: number): Promise<Contract> {
  const hubChainId = resolveHubChainId(chainId);
  const hubPool = await getContract(hubChainId, "HubPool");
  const spokePoolAddr = (await hubPool.crossChainContracts(chainId))[1];

  const contract = new Contract(spokePoolAddr, contracts.SpokePool__factory.abi);
  return contract;
}
