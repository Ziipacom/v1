import assert from "node:assert/strict";
import test from "node:test";
import {metaMaskPairingLink} from "../src/lib/wallet-links.ts";

test("MetaMask receives only an encoded WalletConnect v2 pairing URI", () => {
  const uri=`wc:${"a".repeat(64)}@2?relay-protocol=irn&symKey=${"b".repeat(64)}`;
  const link=metaMaskPairingLink(uri);
  assert.equal(link,"metamask://wc?uri="+encodeURIComponent(uri));
  for(const bad of ["https://evil.test","metamask://",uri.replace("@2","@1"),uri.replace("irn","evil"),uri+"\n",uri.replace("symKey=","key=")])
    assert.throws(() => metaMaskPairingLink(bad));
});
