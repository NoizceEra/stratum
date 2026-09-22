/**
 * wallet.js — Solana wallet helper for STRATUM commerce (SPL token STRM).
 * Zero npm deps. Talks to the injected wallet (Phantom / Solflare / any
 * window.solana-compatible provider) for connect, and to the configured RPC
 * via plain fetch for the STRM token balance.
 */
'use strict';
(function (root) {
  // Genesis hashes per cluster — lets ensureCluster() refuse a wallet that is
  // pointed at the wrong network instead of reading a balance from thin air.
  var GENESIS = {
    'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    'devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqaHMmooUoP4luFn',
    'testnet': '4uhcVJyU9pJkvQyS88u3FJrTX3ZZAUsWwoJpDl7iDeU'
  };

  function provider() {
    if (typeof window === 'undefined') return null;
    if (window.phantom && window.phantom.solana) return window.phantom.solana;
    if (window.solana) return window.solana;
    if (window.solflare) return window.solflare;
    return null;
  }

  function shortAddr(a) {
    if (!a || a.length < 10) return a || '';
    return a.slice(0, 6) + '…' + a.slice(-4);
  }

  async function connect() {
    var w = provider();
    if (!w) throw new Error('No Solana wallet found — install Phantom or Solflare');
    var res = await w.connect();
    var key = (res && res.publicKey) || w.publicKey;
    if (!key) throw new Error('No account returned');
    return key.toString();
  }

  async function ensureCluster(commerce) {
    if (!commerce) throw new Error('Missing commerce config');
    var want = commerce.cluster || 'mainnet-beta';
    if (want === 'localhost') return true;
    var w = provider();
    if (!w) throw new Error('No Solana wallet found — install Phantom or Solflare');
    try {
      if (typeof w.getGenesisHash === 'function') {
        var got = await w.getGenesisHash();
        var wantHash = GENESIS[want];
        if (wantHash && got && got !== wantHash) {
          throw new Error('Please point your wallet at Solana ' + want);
        }
      }
    } catch (e) {
      if (e && e.message && e.message.indexOf('point your wallet') === 0) throw e;
      // Wallet doesn't expose the genesis hash — don't block, the RPC reads below
      // still go to the cluster in `commerce`, which is what the server settles on.
    }
    return true;
  }

  async function rpc(method, params, rpcUrl) {
    var res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    });
    if (!res.ok) throw new Error('RPC request failed');
    var body = await res.json();
    if (body.error) throw new Error((body.error && body.error.message) || 'RPC error');
    return body.result;
  }

  // Raw base-unit balance (decimal string) across all token accounts for the mint.
  async function balanceOf(commerce, address) {
    if (!commerce || !(commerce.tokenMint || commerce.tokenAddress) || !address) return null;
    var mint = commerce.tokenMint || commerce.tokenAddress;
    var result = await rpc('getTokenAccountsByOwner', [address,
      { mint: mint }, { encoding: 'jsonParsed' }], commerce.rpcUrl);
    var total = BigInt(0);
    var list = (result && result.value) || [];
    for (var i = 0; i < list.length; i++) {
      try {
        var amt = list[i].account.data.parsed.info.tokenAmount.amount;
        if (typeof amt === 'string') total += BigInt(amt);
      } catch (e) {}
    }
    return total.toString(10);
  }

  function formatUnits(rawStr, decimals) {
    decimals = (typeof decimals === 'number' && decimals >= 0) ? decimals : 9;
    var s = String(rawStr || '0');
    if (s === '0') return '0';
    if (s.length <= decimals) {
      return '0.' + s.padStart(decimals, '0').replace(/0+$/, '').replace(/\.$/, '') || '0';
    }
    var whole = s.slice(0, s.length - decimals);
    var frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? (whole + '.' + frac) : whole;
  }

  async function readDecimals(commerce) {
    try {
      var mint = commerce.tokenMint || commerce.tokenAddress;
      var result = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }], commerce.rpcUrl);
      var d = result && result.value && result.value.data &&
        result.value.data.parsed && result.value.data.parsed.info &&
        result.value.data.parsed.info.decimals;
      return (typeof d === 'number' && d >= 0 && d <= 9) ? d : (commerce.decimals | 0);
    } catch (e) {
      return commerce.decimals | 0;
    }
  }

  function bytesToB64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  // Fixed message the server verifies in src/wallet-proof.js. Proves this
  // browser holds the wallet before a link can resume another colonist.
  async function signLink(address, playerKey, nonce) {
    var w = provider();
    if (!w || typeof w.signMessage !== 'function') {
      throw new Error('This wallet cannot sign — update Phantom or Solflare');
    }
    var msg = new TextEncoder().encode('STRATUM\nwallet\n' + address + '\n' + playerKey + '\n' + nonce);
    var signed = await w.signMessage(msg, 'utf8');
    var sig = signed && signed.signature ? signed.signature : signed;
    if (!sig || !sig.length) throw new Error('Wallet returned no signature');
    return bytesToB64(sig);
  }

  root.StratumWallet = {
    provider: provider,
    connect: connect,
    signLink: signLink,
    ensureCluster: ensureCluster,
    // Back-compat alias: the HUD calls ensureChain(); on Solana there is no
    // EVM-style chain switch — this verifies the wallet's cluster instead.
    ensureChain: ensureCluster,
    balanceOf: balanceOf,
    formatUnits: formatUnits,
    readDecimals: readDecimals,
    shortAddr: shortAddr
  };
})(typeof window !== 'undefined' ? window : globalThis);
