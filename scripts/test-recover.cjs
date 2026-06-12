const fs=require("fs"),path=require("path");
const anchor=require("../frontend/node_modules/@coral-xyz/anchor");
const {PublicKey,Connection,Keypair,Transaction,SystemProgram,LAMPORTS_PER_SOL}=require("../frontend/node_modules/@solana/web3.js");
const {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,TOKEN_PROGRAM_ID}=require("../frontend/node_modules/@solana/spl-token");
const PID=new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi"),MINT=new PublicKey("CU4JxjFB16HLz5mfppgdGfHpbS7gde5SLsxRSXLh7KU6");
const SOL_USD=new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu"),ETH_USD=new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");
const idl=require("../frontend/src/lib/idl/shear.json");const sym=Buffer.alloc(16);sym.write("SOL-ETH");
const [market]=PublicKey.findProgramAddressSync([Buffer.from("market"),sym],PID);
const [pool]=PublicKey.findProgramAddressSync([Buffer.from("pool"),market.toBuffer()],PID);
const base=new Connection("https://api.devnet.solana.com","confirmed"),er=new Connection("https://devnet.magicblock.app","confirmed");
async function send(conn,kp,ixs,label,tolerate){const tx=new Transaction().add(...ixs);tx.feePayer=kp.publicKey;tx.recentBlockhash=(await conn.getLatestBlockhash()).blockhash;tx.sign(kp);const sig=await conn.sendRawTransaction(tx.serialize(),{skipPreflight:true});const r=await conn.confirmTransaction(sig,"confirmed");if(r.value.err){const t=await conn.getTransaction(sig,{maxSupportedTransactionVersion:0,commitment:"confirmed"});const msg=`${label}: `+JSON.stringify(r.value.err);if(tolerate){console.log("   "+label+" FAILED:",JSON.stringify(r.value.err));return false;}throw new Error(msg+"\n"+(t?.meta?.logMessages||[]).slice(-4).join("\n"));}console.log(`   ${label} OK`);return true;}
const onER=async k=>{const i=await er.getAccountInfo(k);return !!i&&i.data.length>0;};
const waitER=async ks=>{for(let i=0;i<25;i++){if((await Promise.all(ks.map(onER))).every(Boolean))return;await new Promise(r=>setTimeout(r,1000));}throw new Error("ER not ready");};
const settled=async k=>{for(let i=0;i<25;i++){const b=await base.getAccountInfo(k);if(b&&b.owner.equals(PID))return;await new Promise(r=>setTimeout(r,1500));}};
(async()=>{
const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME,".config/solana/devnet-trading-wallet.json"),"utf8"))));
const owner=Keypair.generate(),sk=Keypair.generate();console.log("owner:",owner.publicKey.toBase58());
await send(base,admin,[SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:owner.publicKey,lamports:0.2*LAMPORTS_PER_SOL}),SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:sk.publicKey,lamports:0.08*LAMPORTS_PER_SOL})],"fund");
const w={publicKey:owner.publicKey,signTransaction:async t=>(t.partialSign(owner),t)};
const prog=new anchor.Program(idl,new anchor.AnchorProvider(base,w,{})),erp=new anchor.Program(idl,new anchor.AnchorProvider(er,w,{}));
const [ub]=PublicKey.findProgramAddressSync([Buffer.from("user"),owner.publicKey.toBuffer()],PID);
const [pos]=PublicKey.findProgramAddressSync([Buffer.from("position"),owner.publicKey.toBuffer(),market.toBuffer()],PID);
const ata=getAssociatedTokenAddressSync(MINT,owner.publicKey);
const erAcc={signer:sk.publicKey,market,pool,userBalance:ub,position:pos,basePrice:SOL_USD,quotePrice:ETH_USD,sessionToken:null};
await send(base,owner,[createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,ata,owner.publicKey,MINT),await prog.methods.faucet().accounts({recipient:owner.publicKey,usdcMint:MINT,recipientUsdc:ata,tokenProgram:TOKEN_PROGRAM_ID}).instruction(),await prog.methods.depositCollateral(new anchor.BN(120_000_000)).accounts({trader:owner.publicKey,traderUsdc:ata,tokenProgram:TOKEN_PROGRAM_ID}).instruction(),await prog.methods.initPosition().accounts({owner:owner.publicKey,market,position:pos}).instruction(),await prog.methods.setSessionKey(sk.publicKey).accounts({owner:owner.publicKey,userBalance:ub}).instruction()],"setup");
await send(base,owner,[await prog.methods.delegateUserBalance().accounts({payer:owner.publicKey,userBalance:ub}).instruction()],"delegate ub");
await send(base,owner,[await prog.methods.delegatePosition().accounts({payer:owner.publicKey,market,position:pos}).instruction()],"delegate pos");
await send(er,sk,[await erp.methods.openPosition({long:{}},new anchor.BN(100_000_000),5).accounts(erAcc).instruction()],"open");
await send(er,sk,[await erp.methods.undelegateTrader().accounts({payer:sk.publicKey,userBalance:ub,position:pos}).instruction()],"undelegate WHILE OPEN");
await settled(ub);await settled(pos);
console.log("== stranded. trying recovery variants ==");
// Variant: re-delegate, then RETRY close up to 4x with delays
await send(base,owner,[await prog.methods.delegateUserBalance().accounts({payer:owner.publicKey,userBalance:ub}).instruction()],"re-delegate ub");
await send(base,owner,[await prog.methods.delegatePosition().accounts({payer:owner.publicKey,market,position:pos}).instruction()],"re-delegate pos");
await waitER([market,pool,ub,pos]);
let ok=false;
for(let i=1;i<=4&&!ok;i++){await new Promise(r=>setTimeout(r,i*2000));ok=await send(er,sk,[await erp.methods.closePosition().accounts(erAcc).instruction()],`close attempt ${i}`,true);}
if(ok){console.log("\nRECOVERY WORKS via retry ✓");return;}
console.log("== retry didn't work; trying undelegate->redelegate->close ==");
await send(er,sk,[await erp.methods.undelegateTrader().accounts({payer:sk.publicKey,userBalance:ub,position:pos}).instruction()],"undelegate again",true);
await settled(ub);await settled(pos);
await send(base,owner,[await prog.methods.delegateUserBalance().accounts({payer:owner.publicKey,userBalance:ub}).instruction()],"re-delegate ub 2",true);
await send(base,owner,[await prog.methods.delegatePosition().accounts({payer:owner.publicKey,market,position:pos}).instruction()],"re-delegate pos 2",true);
await waitER([market,pool,ub,pos]);
ok=await send(er,sk,[await erp.methods.closePosition().accounts(erAcc).instruction()],"close after double-cycle",true);
console.log(ok?"\nRECOVERY WORKS via double-cycle ✓":"\nNO RECOVERY — stranded-open is unrecoverable. Fresh wallet required.");
})().catch(e=>{console.error("FAILED:\n",e.message||e);process.exit(1);});
