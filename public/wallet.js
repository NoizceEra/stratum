/**
 * wallet.js — vanilla EIP-1193 helper for STRATUM commerce on Robinhood Chain.
 * Zero npm deps. Reads ERC-20 balanceOf against the configured token address.
 */
'use strict';
(function (root) {
  var ERC20_BALANCE_OF = '0x70a08231';
  var ERC20_DECIMALS = '0x313ce567';
  var ERC20_SYMBOL = '0x95d89b41';

  function hexToInt(hex) {
    if (!hex || hex === '0x') return 0;
    try { return parseInt(hex, 16); } catch (e) { return 0; }
  }

  function padAddr(addr) {
    return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  }

  function provider() {
    return (typeof window !== 'undefined' && window.ethereum) ? window.ethereum : null;
  }

  function shortAddr(a) {
    if (!a || a.length < 10) return a || '';
    return a.slice(0, 6) + '…' + a.slice(-4);
  }

  async function request(method, params) {
    var eth = provider();
    if (!eth) throw new Error('No wallet found — install MetaMask or another EIP-1193 wallet');
    return eth.request({ method: method, params: params || [] });
  }

  async function connect() {
    var accounts = await request('eth_requestAccounts');
    if (!accounts || !accounts.length) throw new Error('No account returned');
    return accounts[0];
  }

  async function chainId() {
    var id = await request('eth_chainId');
    return hexToInt(id);
  }

  async function ensureChain(commerce) {
    if (!commerce) throw new Error('Missing commerce config');
    var want = commerce.chainId | 0;
    var cur = await chainId();
    if (cur === want) return true;
    var hexId = '0x' + want.toString(16);
    try {
      await request('wallet_switchEthereumChain', [{ chainId: hexId }]);
      return true;
    } catch (e) {
      // 4902 = unknown chain — add it
      if (e && (e.code === 4902 || e.code === -32603 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
        await request('wallet_addEthereumChain', [{
          chainId: hexId,
          chainName: commerce.chainName || 'Robinhood Chain',
          nativeCurrency: commerce.nativeCurrency || { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: [commerce.rpcUrl],
          blockExplorerUrls: commerce.explorerUrl ? [commerce.explorerUrl] : []
        }]);
        return true;
      }
      throw e;
    }
  }

  async function ethCall(to, data) {
    return request('eth_call', [{ to: to, data: data }, 'latest']);
  }

  async function balanceOf(commerce, address) {
    if (!commerce || !commerce.tokenAddress || !address) return null;
    var data = ERC20_BALANCE_OF + padAddr(address);
    var raw = await ethCall(commerce.tokenAddress, data);
    return hexToBig(raw);
  }

  function hexToBig(hex) {
    if (!hex || hex === '0x') return '0';
    // keep as decimal string to avoid JS number overflow for 18-dec tokens
    var h = hex.replace(/^0x/, '');
    if (!h) return '0';
    var n = BigInt('0x' + h);
    return n.toString(10);
  }

  function formatUnits(rawStr, decimals) {
    decimals = (typeof decimals === 'number' && decimals >= 0) ? decimals : 18;
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
      var raw = await ethCall(commerce.tokenAddress, ERC20_DECIMALS);
      var d = hexToInt(raw);
      return (d >= 0 && d <= 36) ? d : (commerce.decimals | 0);
    } catch (e) {
      return commerce.decimals | 0;
    }
  }

  root.StratumWallet = {
    provider: provider,
    connect: connect,
    chainId: chainId,
    ensureChain: ensureChain,
    balanceOf: balanceOf,
    formatUnits: formatUnits,
    readDecimals: readDecimals,
    shortAddr: shortAddr
  };
})(typeof window !== 'undefined' ? window : globalThis);
