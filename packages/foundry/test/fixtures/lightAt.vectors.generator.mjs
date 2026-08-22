import { keccak256, encodeAbiParameters } from "viem";
const CYCLE=40n, MIN=12n, MAX=30n;
// Mirrors: keccak256(abi.encode(uint32 roundId, uint256 cycleIndex))
function greenBlocksInCycle(roundId, cycleIndex){
  const h = BigInt(keccak256(encodeAbiParameters(
    [{type:"uint32"},{type:"uint256"}], [Number(roundId), cycleIndex])));
  return MIN + (h % (MAX - MIN + 1n));
}
function lightAt(roundId, roundStartBlock, blockNumber){
  const elapsed = blockNumber - roundStartBlock;
  return (elapsed % CYCLE) < greenBlocksInCycle(roundId, elapsed / CYCLE);
}
const vecs=[];
for (const [rid,start] of [[1n,1000n],[2n,55922506n],[7n,0n]])
  for (let i=0n;i<12n;i++){
    const b = start + i*7n;
    vecs.push({roundId:Number(rid), startBlock:start.toString(), block:b.toString(),
      green: lightAt(rid,start,b), greenInCycle: greenBlocksInCycle(rid,(b-start)/CYCLE).toString()});
  }
console.log(JSON.stringify(vecs.slice(0,6), null, 1));
console.log(`... ${vecs.length} vectors total`);
import { writeFileSync } from "fs";
writeFileSync("/tmp/rlgb/lightAt.vectors.json", JSON.stringify(vecs,null,2));
console.log("written to /tmp/rlgb/lightAt.vectors.json");
