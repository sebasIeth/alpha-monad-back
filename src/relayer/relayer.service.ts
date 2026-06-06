import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as bs58 from 'bs58';
import { ConfigService } from '../common/config/config.service';

const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Pod's on-chain deposit program (Anchor). deposit_usdc(code: [u8;8], amount: u64).
const POD_PROGRAM = new PublicKey('BBAdcqUkg68JXNiPQ1HR1wujfZuayyK3eQTQSYAh6FSW');
const DEPOSIT_USDC_DISCRIMINATOR = Buffer.from([184, 148, 250, 169, 224, 213, 34, 126]);

function bs58Decode(s: string): Uint8Array {
  const lib = (bs58 as any).default ?? bs58;
  return lib.decode(s);
}

/**
 * Cross-chain relayer: the game/stake lives on Monad (EVM), but the AI brain
 * (Pod, usepod.ai) is funded with USDC on Solana. The relayer holds a Solana
 * wallet with USDC; when a user funds their agent's brain, the relayer deposits
 * the equivalent USDC into the agent's Pod on Solana via `deposit_usdc`.
 *
 * The Monad side (collecting the user's USDC into the relayer wallet) is handled
 * by the managed-agent service before calling fundPodBrain here.
 */
@Injectable()
export class RelayerService {
  private readonly logger = new Logger(RelayerService.name);
  private connection: Connection | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getConnection(): Connection {
    if (!this.connection) {
      const rpcUrl =
        process.env.SOLANA_MAINNET_RPC_URL ||
        (this.configService.solanaRpcUrl && !/devnet|testnet/i.test(this.configService.solanaRpcUrl)
          ? this.configService.solanaRpcUrl
          : 'https://api.mainnet-beta.solana.com');
      this.connection = new Connection(rpcUrl, 'confirmed');
    }
    return this.connection;
  }

  /** The relayer's Solana keypair (holds USDC + SOL for Pod deposits). */
  private relayerKeypair(): Keypair {
    const key = this.configService.solanaPrivateKey;
    if (!key) throw new BadRequestException('Relayer Solana key not configured (SOLANA_PRIVATE_KEY).');
    return Keypair.fromSecretKey(bs58Decode(key));
  }

  /** Live USDC balance of the relayer's Solana wallet. */
  async relayerUsdcBalance(): Promise<number> {
    try {
      const conn = this.getConnection();
      const relayer = this.relayerKeypair();
      const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT_MAINNET), relayer.publicKey);
      const acc = await getAccount(conn, ata);
      return Number(acc.amount) / 1_000_000;
    } catch {
      return 0;
    }
  }

  /**
   * Deposit `amountUsdc` into an agent's Pod brain on Solana using the relayer's
   * Solana USDC. The relayer signs + pays. Returns the Solana tx signature.
   *
   * @param podDepositCode 16-hex-char deposit code issued by Pod on register
   */
  async fundPodBrain(podDepositCode: string, amountUsdc: number): Promise<string> {
    if (!amountUsdc || amountUsdc <= 0) throw new BadRequestException('amount must be > 0');
    if (!podDepositCode || !/^[0-9a-fA-F]{16}$/.test(podDepositCode)) {
      throw new BadRequestException('Invalid Pod deposit code');
    }

    const conn = this.getConnection();
    const relayer = this.relayerKeypair();
    const mint = new PublicKey(USDC_MINT_MAINNET);

    // Ensure the relayer holds enough Solana USDC to credit the Pod.
    const have = await this.relayerUsdcBalance();
    if (have < amountUsdc) {
      throw new BadRequestException(
        `Relayer Solana USDC too low: has ${have}, needs ${amountUsdc}. Top up the relayer wallet.`,
      );
    }

    // Resolve config PDA + ops_wallet (deposits are forwarded there).
    const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], POD_PROGRAM);
    const cfgInfo = await conn.getAccountInfo(config);
    if (!cfgInfo) throw new BadRequestException('Pod program config not found on-chain');
    const opsWallet = new PublicKey(cfgInfo.data.slice(8, 40));

    const depositorAta = getAssociatedTokenAddressSync(mint, relayer.publicKey);
    const opsAta = getAssociatedTokenAddressSync(mint, opsWallet, true);

    const code = Buffer.from(podDepositCode, 'hex');
    const amt = Buffer.alloc(8);
    amt.writeBigUInt64LE(BigInt(Math.round(amountUsdc * 1_000_000)));
    const data = Buffer.concat([DEPOSIT_USDC_DISCRIMINATOR, code, amt]);

    const ix = new TransactionInstruction({
      programId: POD_PROGRAM,
      keys: [
        { pubkey: depositorAta, isSigner: false, isWritable: true },
        { pubkey: opsAta, isSigner: false, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = relayer.publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, [relayer], { commitment: 'confirmed' });
    this.logger.log(`Relayer Pod deposit ok: ${amountUsdc} USDC (tx: ${sig})`);
    return sig;
  }
}
