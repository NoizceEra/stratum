// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * StratumToken (STRM) — the official STRATUM game token.
 *
 * WHY THIS IS THE ONE PLACE THIS PROJECT USES A THIRD-PARTY CONTRACT LIBRARY
 *   Every line of the STRATUM game server is hand-rolled and dependency-free by design
 *   (see the project README). A token contract holding real, tradeable value is exactly
 *   the wrong place to keep that habit — ERC-20 has failure modes (approve/transferFrom
 *   race conditions, missing return-value checks, non-standard decimals handling) that a
 *   from-scratch implementation is likely to get subtly wrong in ways that are expensive
 *   later. OpenZeppelin's ERC20/ERC20Burnable/Ownable are the industry-standard, heavily
 *   audited building blocks for exactly this; this file only adds STRATUM-specific glue
 *   on top, not a reimplementation of the standard itself.
 *
 * DESIGN — fixed supply, not open-ended mint
 *   The entire `initialSupply` is minted ONCE, at deploy, straight to `treasury`. There is
 *   no `mint()` function anywhere in this contract or its parents that this contract
 *   exposes — supply cannot grow after deploy, by anyone, including the owner. This
 *   matters for exactly the reason src/token-sink.js's header explains on the game-server
 *   side: an unbounded-mint token with real settlement wired to it is a worse failure mode
 *   than a fixed pool that can run low. If the treasury signer key is ever compromised,
 *   the attacker can drain at most the treasury's remaining balance — never mint more.
 *
 * BURNING
 *   ERC20Burnable gives every holder `burn(amount)` (their own balance) and `burnFrom`
 *   (an approved allowance). This is what makes src/token-sink.js's economics real once
 *   on-chain balances exist beyond the treasury: today, Earth Requisition and Structure
 *   Rush burn purely on the server's off-chain pending ledger (nothing minted yet, so
 *   nothing to burn on-chain) — but a player who has actually claimed/settled real STRM
 *   to their wallet and later spends it back in-game can have that spend become a genuine
 *   on-chain burn via this function, rather than a second off-chain-only bookkeeping trick.
 *
 * OWNERSHIP
 *   `Ownable(treasury)` — the treasury address is also the initial owner, whose only
 *   special power here is `rescueERC20` (below). Transfer ownership with `transferOwnership`
 *   if the operator ever wants a different admin address; STRM's own supply and transfers
 *   are never gated by ownership.
 *
 * WHAT THIS CONTRACT DELIBERATELY DOES NOT DO
 *   No pausability, no blocklist, no upgradeability/proxy pattern, no fee-on-transfer. A
 *   simple, standard, permanent, unstoppable ERC-20 is a stronger promise to players than
 *   a token an operator can freeze or upgrade out from under them — add those later as a
 *   genuinely separate, deliberate decision, not a default baked in here.
 *
 * DEPLOYMENT — NOT DONE BY THIS AGENT
 *   Deploying this contract is an irreversible on-chain action that spends real gas and
 *   creates a real, permanent supply of value — that is the operator's own action to take,
 *   with their own wallet, never something to be done inside this coding session. See
 *   contracts/README.md for the deploy walkthrough (Remix is the path needing no local
 *   toolchain) and what to do with the resulting address afterward.
 */
contract StratumToken is ERC20, ERC20Burnable, Ownable {
    /**
     * @param initialSupply Whole-token supply to mint at deploy (this constructor scales
     *   it by 10**decimals() — pass e.g. 1_000_000_000 for one billion STRM, not the
     *   already-scaled wei-equivalent value).
     * @param treasury      Address to receive the entire initial supply, and the initial
     *   owner. Should be STRATUM's real, funded treasury wallet (see README.md's Commerce
     *   section) — never a throwaway or test address.
     */
    constructor(uint256 initialSupply, address treasury)
        ERC20("STRATUM", "STRM")
        Ownable(treasury)
    {
        require(treasury != address(0), "StratumToken: treasury is the zero address");
        require(initialSupply > 0, "StratumToken: initial supply must be positive");
        _mint(treasury, initialSupply * 10 ** decimals());
    }

    /**
     * Recover a DIFFERENT ERC-20 token accidentally sent to this contract's address —
     * this happens to real tokens in the wild (a wallet paste error, a bridge misroute).
     * Cannot touch STRM's own balance here under any circumstance: if this contract ever
     * holds STRM itself, that's real player-earned or treasury-held supply, not an
     * accident to "rescue" through an owner-only backdoor.
     */
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(this), "StratumToken: cannot rescue STRM itself");
        require(to != address(0), "StratumToken: cannot rescue to the zero address");
        bool sent = ERC20(token).transfer(to, amount);
        require(sent, "StratumToken: rescue transfer failed");
    }
}
