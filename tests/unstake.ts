import BN from "bn.js";
import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  sendAndConfirmTransaction,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  StakeProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import { findPoolFeeAccount, findPoolSolReserves } from "../ts/src/pda";
import { Unstake } from "../target/types/unstake";
import {
  airdrop,
  createDelegateStakeTx,
  fetchLpFacingTestParams,
  stakeAccMinLamports,
  testVoteAccount,
  transferStakeAuthTx,
  waitForEpochToPass,
} from "./utils";
import { expect, use as chaiUse } from "chai";
import chaiAsPromised from "chai-as-promised";
import { getStakeAccount, stakeAccountState } from "./stake";

chaiUse(chaiAsPromised);

describe("unstake", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.getProvider());
  const program = anchor.workspace.Unstake as Program<Unstake>;
  const provider = anchor.getProvider();
  const payerKeypair = Keypair.generate();
  const poolKeypair = Keypair.generate();
  const lpMintKeypair = Keypair.generate();
  const lperKeypair = Keypair.generate();

  let [poolSolReserves, poolSolReservesBump] = [null as PublicKey, 0];
  let [feeAccount, feeAccountBump] = [null as PublicKey, 0];
  let lperAta = null as PublicKey;

  before(async () => {
    console.log("airdropping to payer and lper");
    await airdrop(provider.connection, payerKeypair.publicKey);
    await airdrop(provider.connection, lperKeypair.publicKey);
    [poolSolReserves, poolSolReservesBump] = await findPoolSolReserves(
      program.programId,
      poolKeypair.publicKey
    );
    [feeAccount, feeAccountBump] = await findPoolFeeAccount(
      program.programId,
      poolKeypair.publicKey
    );
    lperAta = await getAssociatedTokenAddress(
      lpMintKeypair.publicKey,
      lperKeypair.publicKey
    );
  });

  it("it initializes a liquidity pool", async () => {
    const lpMint = lpMintKeypair.publicKey;
    await program.methods
      .createPool({
        fee: {
          liquidityLinear: {
            params: {
              maxLiqRemaining: {
                num: new BN(0),
                denom: new BN(69),
              },
              zeroLiqRemaining: {
                num: new BN(1),
                denom: new BN(1000),
              },
            },
          },
        },
      })
      .accounts({
        payer: payerKeypair.publicKey,
        feeAuthority: payerKeypair.publicKey,
        poolAccount: poolKeypair.publicKey,
        lpMint,
        poolSolReserves,
        feeAccount,
      })
      .signers([payerKeypair, poolKeypair, lpMintKeypair])
      .rpc({ skipPreflight: true });
    const mint = await getMint(provider.connection, lpMint);
    expect(mint.decimals).to.eq(9);
    expect(mint.supply).to.eq(BigInt(0));
  });

  describe("LP facing", () => {
    const AMOUNT = new BN(0.1 * LAMPORTS_PER_SOL);

    before(async () => {
      // create lper ata
      await createAssociatedTokenAccount(
        provider.connection,
        lperKeypair,
        lpMintKeypair.publicKey,
        lperKeypair.publicKey
      );
    });

    it("it add liquidity from zero", async () => {
      const {
        lperAtaAmount: lperAtaPre,
        poolOwnedLamports: ownedLamportsPre,
        lperLamports: lperLamportsPre,
        reserveLamports: reservesLamportsPre,
      } = await fetchLpFacingTestParams({
        program,
        lper: lperKeypair.publicKey,
        lperAta,
        poolSolReserves,
        pool: poolKeypair.publicKey,
      });

      await program.methods
        .addLiquidity(AMOUNT)
        .accounts({
          from: lperKeypair.publicKey,
          poolAccount: poolKeypair.publicKey,
          poolSolReserves,
          lpMint: lpMintKeypair.publicKey,
          mintLpTokensTo: lperAta,
        })
        .signers([lperKeypair])
        .rpc({ skipPreflight: true });

      const {
        lperAtaAmount: lperAtaPost,
        poolOwnedLamports: ownedLamportsPost,
        lperLamports: lperLamportsPost,
        reserveLamports: reservesLamportsPost,
      } = await fetchLpFacingTestParams({
        program,
        lper: lperKeypair.publicKey,
        lperAta,
        poolSolReserves,
        pool: poolKeypair.publicKey,
      });

      expect(lperAtaPre).to.eq(BigInt(0));
      expect(ownedLamportsPre.toString()).to.eq(new BN(0).toString());
      expect(reservesLamportsPre).to.eq(0);
      expect(lperAtaPost).to.eq(lperAtaPre + BigInt(AMOUNT.toString()));
      expect(lperLamportsPost).to.eq(lperLamportsPre - AMOUNT.toNumber());
      expect(reservesLamportsPost).to.eq(
        reservesLamportsPre + AMOUNT.toNumber()
      );
      expect(ownedLamportsPost.toString()).to.eq(
        ownedLamportsPre.add(AMOUNT).toString()
      );
    });

    // TODO: add tests for adding and removing liquidity when liquidity is non-zero here

    it("it remove liquidity to zero", async () => {
      const {
        lperAtaAmount: lperAtaPre,
        poolOwnedLamports: ownedLamportsPre,
        lperLamports: lperLamportsPre,
        reserveLamports: reservesLamportsPre,
      } = await fetchLpFacingTestParams({
        program,
        lper: lperKeypair.publicKey,
        lperAta,
        poolSolReserves,
        pool: poolKeypair.publicKey,
      });

      await program.methods
        .removeLiquidity(AMOUNT)
        .accounts({
          burnLpTokensFromAuthority: lperKeypair.publicKey,
          to: lperKeypair.publicKey,
          poolAccount: poolKeypair.publicKey,
          poolSolReserves,
          lpMint: lpMintKeypair.publicKey,
          burnLpTokensFrom: lperAta,
        })
        .signers([lperKeypair])
        .rpc({ skipPreflight: true });

      const {
        lperAtaAmount: lperAtaPost,
        poolOwnedLamports: ownedLamportsPost,
        lperLamports: lperLamportsPost,
        reserveLamports: reservesLamportsPost,
      } = await fetchLpFacingTestParams({
        program,
        lper: lperKeypair.publicKey,
        lperAta,
        poolSolReserves,
        pool: poolKeypair.publicKey,
      });

      expect(lperAtaPost).to.eq(lperAtaPre - BigInt(AMOUNT.toString()));
      expect(lperLamportsPost).to.eq(lperLamportsPre + AMOUNT.toNumber());
      expect(reservesLamportsPost).to.eq(
        reservesLamportsPre - AMOUNT.toNumber()
      );
      expect(ownedLamportsPost.toString()).to.eq(
        ownedLamportsPre.sub(AMOUNT).toString()
      );
      expect(lperAtaPost).to.eq(BigInt(0));
      expect(ownedLamportsPost.toString()).to.eq(new BN(0).toString());
      expect(reservesLamportsPost).to.eq(0);
    });
  });

  describe("Crank facing", () => {
    it("it deactivates stake account", async () => {
      const stakeAccountKeypair = Keypair.generate();

      const createStakeAuthTx = await createDelegateStakeTx({
        connection: provider.connection,
        stakeAccount: stakeAccountKeypair.publicKey,
        payer: payerKeypair.publicKey,
      });
      createStakeAuthTx.add(
        transferStakeAuthTx({
          authorizedPubkey: payerKeypair.publicKey,
          newAuthorizedPubkey: poolSolReserves,
          stakePubkey: stakeAccountKeypair.publicKey,
        })
      );

      await sendAndConfirmTransaction(provider.connection, createStakeAuthTx, [
        payerKeypair,
        stakeAccountKeypair,
      ]);

      const stakeAccActivating = await getStakeAccount(
        provider.connection,
        stakeAccountKeypair.publicKey
      );
      const { epoch: activatingEpoch } =
        await provider.connection.getEpochInfo();
      expect(
        stakeAccountState(stakeAccActivating, new BN(activatingEpoch))
      ).to.eq("activating");

      await waitForEpochToPass(provider.connection);

      const stakeAccActive = await getStakeAccount(
        provider.connection,
        stakeAccountKeypair.publicKey
      );
      const { epoch: activeEpoch } = await provider.connection.getEpochInfo();
      expect(activeEpoch).to.eq(activatingEpoch + 1);
      expect(stakeAccountState(stakeAccActive, new BN(activeEpoch))).to.eq(
        "active"
      );

      await program.methods
        .deactivateStakeAccount()
        .accounts({
          stakeAccount: stakeAccountKeypair.publicKey,
          poolAccount: poolKeypair.publicKey,
          poolSolReserves,
          // idk why anchor can't infer clock sysvar
          clock: SYSVAR_CLOCK_PUBKEY,
          // anchor can't infer stake_prog
          stakeProgram: StakeProgram.programId,
        })
        .rpc({ skipPreflight: true });

      const stakeAccDeactivating = await getStakeAccount(
        provider.connection,
        stakeAccountKeypair.publicKey
      );
      const { epoch: deactivatingEpoch } =
        await provider.connection.getEpochInfo();
      expect(deactivatingEpoch).to.eq(activeEpoch);
      expect(
        stakeAccountState(stakeAccDeactivating, new BN(deactivatingEpoch))
      ).to.eq("deactivating");
    });

    it("it reclaims stake account", async () => {
      // TODO: call unstake() here to create the stake account record
    });
  });

  it("it sets fee", async () => {
    await program.methods
      .setFee({
        fee: {
          liquidityLinear: {
            params: {
              maxLiqRemaining: {
                num: new BN(42),
                denom: new BN(69),
              },
              zeroLiqRemaining: {
                num: new BN(1),
                denom: new BN(1000),
              },
            },
          },
        },
      })
      .accounts({
        feeAuthority: payerKeypair.publicKey,
        poolAccount: poolKeypair.publicKey,
        feeAccount,
      })
      .signers([payerKeypair])
      .rpc({ skipPreflight: true });

    // TODO: assertions
  });

  it("it reject to set fee when the authority does not match", async () => {
    const rando = Keypair.generate();
    return expect(
      program.methods
        .setFee({
          fee: {
            liquidityLinear: {
              params: {
                maxLiqRemaining: {
                  num: new BN(42),
                  denom: new BN(100),
                },
                zeroLiqRemaining: {
                  num: new BN(2),
                  denom: new BN(1000),
                },
              },
            },
          },
        })
        .accounts({
          feeAuthority: rando.publicKey,
          poolAccount: poolKeypair.publicKey,
          feeAccount,
        })
        .signers([rando])
        .rpc({ skipPreflight: true })
    ).to.be.eventually.rejected.then(function (err) {
      expect(err).to.have.a.property("code", 6006);
      expect(err).to.have.a.property(
        "msg",
        "The provided fee authority does not have the authority over the provided pool account"
      );
    });
  });
});
