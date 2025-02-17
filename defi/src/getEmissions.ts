import fetch from "node-fetch";
import { getR2 } from "./utils/r2";
import { wrap, IResponse, successResponse } from "./utils/shared";

type ProtocolData = {
  token: string;
  tokenPrice?: any[];
  symbol?: string;
  sources: string[];
  protocolId?: string;
  name: string;
  circSupply: number;
  totalLocked: number;
  maxSupply: number;
  nextEvent?: {
    date: string;
    toUnlock: number;
    proportion?: number;
  };
  gecko_id?: string;
  mcap?: any;
  events?: any;
};

const fetchProtocolData = async (protocols: string[]): Promise<ProtocolData[]> => {
  const protocolsData: ProtocolData[] = [];
  const now: number = Math.floor(Date.now() / 1000);

  await Promise.all(
    protocols.map(async (protocol: string) => {
      let res: any;
      try {
        res = await getR2(`emissions/${protocol}`).then((res) => (res.body ? JSON.parse(res.body) : null));
      } catch {
        console.log(`${protocol} has no emissions in R2`);
        return;
      }
      if ((res.documentedData?.data ?? res.data) == null) return;

      const data: { [date: number]: number } = {};
      try {
        (res.documentedData?.data ?? res.data).forEach(
          (item: { data: Array<{ timestamp: number; unlocked: number }> }) => {
            if (item.data == null) return;
            item.data.forEach((value) => {
              data[value.timestamp] = (data[value.timestamp] || 0) + value.unlocked;
            });
          }
        );
      } catch {
        console.error(`${protocol} failed`);
        return;
      }

      const formattedData = Object.entries(data);
      const maxSupply = formattedData[formattedData.length - 1][1];
      const rawNextEvent = res.metadata.events.find((e: any) => e.timestamp > now);

      let nextEvent;
      if (!rawNextEvent) {
        nextEvent = undefined;
      } else if ((rawNextEvent.noOfTokens.length = 1)) {
        nextEvent = {
          date: rawNextEvent.timestamp,
          toUnlock: Math.max(rawNextEvent.noOfTokens[0], 0),
        };
      } else {
        nextEvent = {
          date: Math.ceil(now / 86400) * 86400,
          toUnlock: Math.max(rawNextEvent.noOfTokens[1], 0),
        };
      }
      const nextUnlockIndex = formattedData.findIndex(([date]) => Number(date) > now);
      const circSupply = nextUnlockIndex != -1 ? formattedData[nextUnlockIndex - 1]?.[1] ?? [] : maxSupply;

      protocolsData.push({
        token: res.metadata.token,
        sources: res.metadata.sources,
        protocolId: res.metadata.protocolIds?.[0] ?? null,
        name: res.name,
        circSupply,
        totalLocked: maxSupply - circSupply,
        maxSupply,
        gecko_id: res.gecko_id,
        events: res.metadata.events,
        nextEvent,
      });
    })
  );

  return protocolsData;
};
const fetchCoinsApiData = async (protocols: ProtocolData[]): Promise<void> => {
  const step: number = 25;
  for (let i = 0; i < protocols.length; i = i + step) {
    const tokens: string = protocols
      .slice(i, Math.min(i + step, protocols.length))
      .reduce((p: string, c: ProtocolData) => `${p},${c.token}`, "")
      .slice(1);
    const coins: string[] = protocols
      .slice(i, Math.min(i + step, protocols.length))
      .map((p: ProtocolData) => `coingecko:${p.gecko_id}`)
      .filter((p: string) => p);

    const [tokenPrices, mcapRes] = await Promise.all([
      fetch(`https://coins.llama.fi/prices/current/${tokens}?searchWidth=4h`).then((res) => res.json()),
      fetch("https://coins.llama.fi/mcaps", {
        method: "POST",
        body: JSON.stringify({
          coins,
        }),
      }).then((r) => r.json()),
    ]);

    protocols.map((p: ProtocolData) => {
      if (p.token in tokenPrices.coins) {
        p.tokenPrice = [tokenPrices.coins[p.token]]; //tokenPrices.coins[p.token].price;
        // p.symbol = tokenPrices.coins[p.token].symbol;
      }
      if (p.gecko_id && `coingecko:${p.gecko_id}` in mcapRes) p.mcap = mcapRes[`coingecko:${p.gecko_id}`]?.mcap ?? 0;
    });
  }
};
const fetchProtocolEmissionData = async (protocol: ProtocolData) => {
  let price = protocol.tokenPrice ? protocol.tokenPrice[0] : undefined;
  if (price) price = price.price;

  const float = protocol.tokenPrice == null || isNaN(price) || protocol.mcap == 0 ? null : protocol.mcap / price;

  if (protocol.nextEvent && float) protocol.nextEvent.proportion = Math.max(protocol.nextEvent.toUnlock / float, 0);
};
const handler = async (_event: any): Promise<IResponse> => {
  const allProtocols = (await getR2(`emissionsProtocolsList`).then((res) => JSON.parse(res.body!))) as string[];
  const data: ProtocolData[] = await fetchProtocolData(allProtocols);
  await fetchCoinsApiData(data);
  await Promise.all(data.map((d: ProtocolData) => fetchProtocolEmissionData(d)));
  return successResponse(
    data.sort((a, b) => b.mcap - a.mcap),
    10 * 60
  ); // 10 mins cache
};

export default wrap(handler);
//handler({}); // ts-node defi/src/getEmissions.ts
