const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com/?api-key=";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function validSolanaAddress(addr){
  return typeof addr === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

function shortAddr(a){
  return a.slice(0,4) + "…" + a.slice(-4);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    return await fetch(url, {...options, signal: controller.signal});
  }finally{
    clearTimeout(timer);
  }
}

async function rpcCall(method, params){
  const apiKey = process.env.HELIUS_API_KEY;
  if(!apiKey) throw new Error("Server is missing HELIUS_API_KEY.");

  const url = HELIUS_RPC_BASE + encodeURIComponent(apiKey);
  let lastError = null;

  for(let attempt = 0; attempt < 3; attempt++){
    try{
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({jsonrpc:"2.0", id:1, method, params})
      }, 15000);

      if(res.status === 429 || res.status >= 500){
        lastError = new Error(`Helius RPC returned ${res.status}`);
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        continue;
      }

      let json;
      try { json = await res.json(); }
      catch(e){ throw new Error("Helius returned an invalid response."); }

      if(!res.ok){
        throw new Error(json?.error?.message || `Helius RPC returned ${res.status}`);
      }
      if(json.error){
        throw new Error(json.error.message || "Helius RPC error.");
      }
      return json.result;
    }catch(e){
      lastError = e;
      if(attempt < 2){
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError || new Error("Helius RPC request failed.");
}

async function getPrices(ids){
  if(!ids.length) return {};
  try{
    const url = "https://api.jup.ag/price/v2?ids=" + encodeURIComponent(ids.join(","));
    const res = await fetchWithTimeout(url, {}, 12000);
    if(!res.ok) return {};
    const json = await res.json();
    return json.data || {};
  }catch(e){
    return {};
  }
}

async function getTokenMeta(mint){
  try{
    const res = await fetchWithTimeout(
      "https://tokens.jup.ag/token/" + encodeURIComponent(mint),
      {},
      8000
    );
    if(!res.ok) return null;
    return await res.json();
  }catch(e){
    return null;
  }
}

function mergeTokenAccounts(values){
  const map = new Map();

  for(const acc of (values || [])){
    const info = acc?.account?.data?.parsed?.info;
    if(!info?.mint || !info?.tokenAmount) continue;

    const amount = Number(info.tokenAmount.uiAmount || 0);
    if(!(amount > 0)) continue;

    const existing = map.get(info.mint);
    if(existing) existing.amount += amount;
    else map.set(info.mint, {mint: info.mint, amount});
  }

  return [...map.values()];
}

module.exports = async function handler(req, res){
  if(req.method !== "POST"){
    res.status(405).json({error:"Method not allowed."});
    return;
  }

  try{
    const address = String(req.body?.address || "").trim();

    if(!validSolanaAddress(address)){
      res.status(400).json({error:"Invalid Solana wallet address."});
      return;
    }

    const [balanceResult, classicResult, token2022Result, sigResult] = await Promise.all([
      rpcCall("getBalance", [address]),

      rpcCall("getTokenAccountsByOwner", [
        address,
        {programId: TOKEN_PROGRAM_ID},
        {encoding:"jsonParsed"}
      ]),

      rpcCall("getTokenAccountsByOwner", [
        address,
        {programId: TOKEN_2022_PROGRAM_ID},
        {encoding:"jsonParsed"}
      ]),

      rpcCall("getSignaturesForAddress", [
        address,
        {limit:50}
      ]).catch(() => [])
    ]);

    const holdings = mergeTokenAccounts([
      ...(classicResult?.value || []),
      ...(token2022Result?.value || [])
    ]);

    const solBalance = Number(balanceResult?.value || 0) / 1e9;
    const sigCount = Array.isArray(sigResult) ? sigResult.length : 0;

    const priceIds = [
      SOL_MINT,
      ...holdings.map(h => h.mint)
    ].slice(0, 100);

    const priceData = await getPrices(priceIds);

    const solPrice = priceData[SOL_MINT]
      ? Number(priceData[SOL_MINT].price)
      : null;

    for(const h of holdings){
      const p = priceData[h.mint];

      h.price = p ? Number(p.price) : null;
      h.value = Number.isFinite(h.price)
        ? h.price * h.amount
        : null;

      h.symbol = shortAddr(h.mint);
    }

    const solValue = Number.isFinite(solPrice)
      ? solPrice * solBalance
      : null;

    const pricedHoldings = holdings
      .filter(h => Number.isFinite(h.value) && h.value > 0.01)
      .sort((a,b) => b.value - a.value);

    const unpricedCount = holdings.length - pricedHoldings.length;

    const topHoldings = pricedHoldings.slice(0, 8);

    await Promise.all(topHoldings.map(async h => {
      const meta = await getTokenMeta(h.mint);
      if(meta?.symbol) h.symbol = meta.symbol;
    }));

    const knownValue =
      (solValue || 0) +
      pricedHoldings.reduce(
        (sum, h) => sum + h.value,
        0
      );

    res.status(200).json({
      addr: address,
      solBalance,
      solPrice,
      solValue,
      pricedHoldings,
      topHoldings,
      unpricedCount,
      totalHoldingsCount: holdings.length,
      knownValue,
      sigCount
    });

  }catch(err){
    console.error("BagScore analyze error:", err);

    const message = err?.message || "Wallet analysis failed.";

    if(message.includes("missing HELIUS_API_KEY")){
      res.status(500).json({
        error:"Server configuration error: Helius API key is missing."
      });
      return;
    }

    if(message.includes("429")){
      res.status(503).json({
        error:"Helius RPC is temporarily rate-limited. Please try again in a few seconds."
      });
      return;
    }

    res.status(502).json({
      error:"Could not reach the Solana data provider. Please try again."
    });
  }
};
