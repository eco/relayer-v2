import { isDefined, winston, BigNumber, getL2TokenAddresses } from "../utils";
import axios, { AxiosError } from "axios";
import { HubPoolClient } from "./HubPoolClient";
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { TOKEN_SYMBOLS_MAP, CHAIN_IDs } from "@across-protocol/constants-v2";
import { SpokePoolClientsByChain } from "../interfaces";
import _ from "lodash";

const { bnZero } = sdkUtils;

export interface DepositLimits {
  maxDeposit: BigNumber;
}

export class AcrossApiClient {
  private endpoint = "https://across.to/api";

  private limits: { [token: string]: BigNumber } = {};

  public updatedLimits = false;

  // Note: Max vercel execution duration is 1 minute
  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    readonly spokePoolClients: SpokePoolClientsByChain,
    readonly tokensQuery: string[] = [],
    readonly timeout: number = 3000
  ) {
    if (Object.keys(tokensQuery).length === 0) {
      this.tokensQuery = Object.entries(TOKEN_SYMBOLS_MAP).map(([, details]) => details.addresses[CHAIN_IDs.MAINNET]);
    }
  }

  async update(ignoreLimits: boolean): Promise<void> {
    if (ignoreLimits) {
      this.logger.debug({ at: "AcrossAPIClient", message: "Skipping querying /limits" });
      return;
    }

    // Note: Skip tokens not currently enabled in HubPool as we won't be able to relay them.
    if (!this.hubPoolClient.isUpdated) {
      throw new Error("HubPoolClient must be updated before AcrossAPIClient");
    }
    const enabledTokens = this.hubPoolClient.getL1Tokens().map((token) => token.address);
    const tokensQuery = this.tokensQuery.filter((token) => enabledTokens.includes(token));
    this.logger.debug({
      at: "AcrossAPIClient",
      message: "Querying /limits",
      timeout: this.timeout,
      tokensQuery,
      endpoint: this.endpoint,
    });
    this.updatedLimits = false;

    // /limits
    // - Store the max deposit limit for each L1 token. DestinationChainId doesn't matter since HubPool
    // liquidity is shared for all tokens and affects maxDeposit. We don't care about maxDepositInstant
    // when deciding whether a relay will be refunded.
    const mainnetSpokePoolClient = this.spokePoolClients[this.hubPoolClient.chainId];
    if (!mainnetSpokePoolClient.isUpdated) {
      throw new Error("Mainnet SpokePoolClient for chainId must be updated before AcrossAPIClient");
    }

    const data = await Promise.all(
      tokensQuery.map((l1Token) => {
        const l2TokenAddresses = getL2TokenAddresses(l1Token);
        const destinationChains = Object.keys(l2TokenAddresses)
          .map((chainId) => Number(chainId))
          .filter((chainId) => {
            return (
              chainId !== CHAIN_IDs.MAINNET &&
              mainnetSpokePoolClient.isDepositRouteEnabled(l1Token, chainId) &&
              Object.keys(this.spokePoolClients).includes(chainId.toString())
            );
          });

        // No valid deposit routes from mainnet for this token. We won't record a limit for it.
        if (destinationChains.length === 0) {
          return undefined;
        }

        return this.callLimits(l1Token, destinationChains);
      })
    );

    tokensQuery.forEach((token, i) => {
      const resolvedData = data[i];
      if (isDefined(resolvedData)) {
        this.limits[token] = data[i].maxDeposit;
      } else {
        this.logger.debug({
          at: "AcrossAPIClient",
          message: "No valid deposit routes for enabled LP token, skipping",
          token,
        });
      }
    });

    this.logger.debug({
      at: "AcrossAPIClient",
      message: "🏁 Fetched max deposit limits",
      limits: this.limits,
    });
    this.updatedLimits = true;
  }

  getLimit(l1Token: string): BigNumber {
    if (!this.limits[l1Token]) {
      throw new Error(`No limit stored for l1Token ${l1Token}`);
    }
    return this.limits[l1Token];
  }

  private async callLimits(
    l1Token: string,
    destinationChainIds: number[],
    timeout = this.timeout
  ): Promise<DepositLimits> {
    const path = "limits";
    const url = `${this.endpoint}/${path}`;

    for (const destinationChainId of destinationChainIds) {
      const params = { token: l1Token, destinationChainId, originChainId: 1 };
      try {
        const result = await axios(url, { timeout, params });
        return result.data;
      } catch (err) {
        const msg = _.get(err, "response.data", _.get(err, "response.statusText", (err as AxiosError).message));
        this.logger.warn({
          at: "AcrossAPIClient",
          message: "Failed to get /limits",
          url,
          params,
          msg,
        });
      }
    }

    return { maxDeposit: bnZero };
  }
}
