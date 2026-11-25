import { SoftwareSigner } from "@hostry/client-core";
import { describe, expect, it } from "vitest";
import { demoPack } from "../../fixtures/demo-pack";
import { PackError, loadVerifiedPack } from "./pack";

const b64 = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url");

function jwkOf(s: SoftwareSigner) {
  const p = Buffer.from(s.publicB64, "base64url");
  return { kty: "EC", crv: "P-256", x: b64(p.subarray(1, 33)), y: b64(p.subarray(33, 65)), kid: s.kid, alg: "ES256", use: "sig" };
}

async function signedStore(signer: SoftwareSigner, edit: (claims: Record<string, unknown>) => void = () => undefined, view: Record<string, unknown> = {}) {
  const { pack } = demoPack();
  const claims: Record<string, unknown> = { pack_v: pack.packV, organisation_id: pack.tenantId, device: { device_id: pack.deviceId }, issuer_env: pack.issuerEnv, identity_public_keys: [jwkOf(signer)] };
  edit(claims);
  const h = b64(JSON.stringify({ alg: "ES256", kid: signer.kid, typ: "hostry-pack+jws" }));
  const p = b64(JSON.stringify(claims));
  return { ...pack, ...view, jws: `${h}.${p}.${await signer.sign(`${h}.${p}`)}` };
}

describe("the pack signature is verified on load", () => {
  it("loads a signed pack and keeps the identity keys it published", async () => {
    const id = await SoftwareSigner.generate("k1");
    const pack = await loadVerifiedPack(await signedStore(id));
    expect(pack.identityKeys).toEqual({ k1: id.publicB64 });
  });

  it("refuses an unsigned pack, a bad signature and a key the device does not hold", async () => {
    const id = await SoftwareSigner.generate("k1");
    const ok = await signedStore(id);
    await expect(loadVerifiedPack({ ...ok, jws: undefined })).rejects.toBeInstanceOf(PackError);
    const [h, p, s] = ok.jws.split(".");
    await expect(loadVerifiedPack({ ...ok, jws: `${h}.${p}.${s!.slice(0, -2)}AA` })).rejects.toThrow(/signature/);
    const held = await SoftwareSigner.generate("k1");
    await expect(loadVerifiedPack(ok, { trusted: { k1: held.publicB64 } })).rejects.toThrow(/signature/);
  });

  it("refuses a view that disagrees with the signed claims (an edited issuer_env, version, tenant or device)", async () => {
    const id = await SoftwareSigner.generate("k1");
    await expect(loadVerifiedPack(await signedStore(id, (c) => (c.issuer_env = "live")))).rejects.toThrow(/issuerEnv/);
    await expect(loadVerifiedPack(await signedStore(id, (c) => (c.pack_v = 99)))).rejects.toThrow(/packV/);
    await expect(loadVerifiedPack(await signedStore(id, (c) => (c.organisation_id = "other")))).rejects.toThrow(/tenantId/);
    await expect(loadVerifiedPack(await signedStore(id, (c) => (c.device = { device_id: "other" })))).rejects.toThrow(/deviceId/);
  });

  it("a view without a valid issuerEnv is not a pack", async () => {
    const id = await SoftwareSigner.generate("k1");
    await expect(loadVerifiedPack(await signedStore(id, () => undefined, { issuerEnv: "staging" }))).rejects.toThrow(/issuerEnv/);
  });
});
