import assert from "node:assert/strict";
import {test} from "vitest";
import {
  verifyAlasPublication,
  verifyInstalledPublication,
} from "./verify-alas-publication.mjs";

const version = "2.1.1-alas.2";
const sourceCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);
const integrityBytes = Buffer.from("exact-package-integrity");
const integrity = `sha512-${integrityBytes.toString("base64")}`;
const expectedRepository = "https://github.com/mrmans0n/codex-acp";
const expectedWorkflowPath = ".github/workflows/publish-alas.yml";
const expectedWorkflowRef = "refs/heads/alas";

function provenanceStatement() {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: `pkg:npm/%40alas-ide/codex-acp@${version}`,
      digest: {sha512: integrityBytes.toString("hex")},
    }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: expectedWorkflowRef,
            repository: expectedRepository,
            path: expectedWorkflowPath,
          },
        },
        resolvedDependencies: [{
          uri: `git+${expectedRepository}@${expectedWorkflowRef}`,
          digest: {gitCommit: sourceCommit},
        }],
      },
    },
  };
}

function mutateProvenance(input, mutate) {
  const envelope = input.attestation.attestations[0].bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  mutate(statement);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
}

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), derLength(bytes.length), bytes]);
}

function derOid(value) {
  const parts = value.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let remaining = part >> 7; remaining > 0; remaining >>= 7) {
      encoded.unshift(0x80 | (remaining & 0x7f));
    }
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}

function certificateBytes({
  issuer = "https://token.actions.githubusercontent.com",
  workflowRef = expectedWorkflowRef,
} = {}) {
  const identity = `${expectedRepository}/${expectedWorkflowPath}@${workflowRef}`;
  const extension = (oid, value) => der(0x30, Buffer.concat([
    derOid(oid),
    der(0x04, value),
  ]));
  return der(0x30, Buffer.concat([
    extension("1.3.6.1.4.1.57264.1.1", Buffer.from(issuer)),
    extension("2.5.29.17", der(0x30, der(0x86, Buffer.from(identity)))),
  ]));
}

function fixture() {
  return {
    packageName: "@alas-ide/codex-acp",
    version,
    sourceCommit,
    upstreamVersion: "2.1.1",
    upstreamCommit,
    expectedIntegrity: integrity,
    expectedRepository,
    expectedWorkflowPath,
    expectedWorkflowRef,
    attestation: {
      attestations: [{
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          verificationMaterial: {
            certificate: {rawBytes: certificateBytes().toString("base64")},
          },
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(provenanceStatement())).toString("base64"),
          },
        },
      }],
    },
    packument: {
      "dist-tags": {latest: version},
      versions: {
        [version]: {
          name: "@alas-ide/codex-acp",
          version,
          alasDownstream: {
            upstreamVersion: "2.1.1",
            upstreamCommit,
            sourceCommit,
          },
          dist: {
            integrity,
            attestations: {
              url: `https://registry.npmjs.org/-/npm/v1/attestations/@alas-ide%2fcodex-acp@${version}`,
              provenance: {predicateType: "https://slsa.dev/provenance/v1"},
            },
          },
        },
      },
    },
    tagCommit: sourceCommit,
    release: {
      tagName: `alas-v${version}`,
      name: `alas-v${version}`,
      targetCommitish: sourceCommit,
      isDraft: false,
      isPrerelease: false,
    },
  };
}

test("verifies exact npm metadata, integrity, provenance, immutable tag, and release target", () => {
  const input = fixture();
  assert.deepEqual(verifyAlasPublication(input), {
    version,
    integrity,
    sourceCommit,
    tag: `alas-v${version}`,
    attestationUrl: input.packument.versions[version].dist.attestations.url,
  });
});

test("rejects every post-publication metadata and provenance mismatch", () => {
  const cases = [
    ["latest", (input) => { input.packument["dist-tags"].latest = "2.1.1-alas.1"; }],
    ["version", (input) => { input.packument.versions[version].version = "2.1.1-alas.1"; }],
    ["integrity", (input) => { input.packument.versions[version].dist.integrity = "sha512-other"; }],
    ["upstreamVersion", (input) => { input.packument.versions[version].alasDownstream.upstreamVersion = "2.1.0"; }],
    ["upstreamCommit", (input) => { input.packument.versions[version].alasDownstream.upstreamCommit = "c".repeat(40); }],
    ["sourceCommit", (input) => { input.packument.versions[version].alasDownstream.sourceCommit = "d".repeat(40); }],
    ["attestations", (input) => { delete input.packument.versions[version].dist.attestations; }],
    ["provenance", (input) => { input.packument.versions[version].dist.attestations.provenance.predicateType = "https://example.invalid"; }],
    ["attestation URL", (input) => { input.packument.versions[version].dist.attestations.url = "https://example.invalid/attestation"; }],
    ["provenance source commit", (input) => mutateProvenance(input, (statement) => {
      statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "c".repeat(40);
    })],
    ["provenance workflow", (input) => mutateProvenance(input, (statement) => {
      statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml";
    })],
    ["provenance subject integrity", (input) => mutateProvenance(input, (statement) => {
      statement.subject[0].digest.sha512 = "00".repeat(32);
    })],
    ["provenance signer workflow", (input) => {
      input.attestation.attestations[0].bundle.verificationMaterial.certificate.rawBytes =
        certificateBytes({workflowRef: "refs/heads/main"}).toString("base64");
    }],
    ["provenance OIDC issuer", (input) => {
      input.attestation.attestations[0].bundle.verificationMaterial.certificate.rawBytes =
        certificateBytes({issuer: "https://issuer.example.invalid"}).toString("base64");
    }],
    ["upstream version", (input) => {
      input.upstreamVersion = "2.1.0";
      input.packument.versions[version].alasDownstream.upstreamVersion = "2.1.0";
    }],
    ["tag", (input) => { input.tagCommit = "e".repeat(40); }],
    ["release target", (input) => { input.release.targetCommitish = "alas"; }],
    ["release version", (input) => { input.release.tagName = "alas-v2.1.1-alas.1"; }],
  ];
  for (const [label, mutate] of cases) {
    const input = structuredClone(fixture());
    mutate(input);
    assert.throws(() => verifyAlasPublication(input), new RegExp(label, "i"), label);
  }
});

test("verifies the exact installed package and cryptographic signature audit across resolved lock paths", () => {
  const packageName = "@alas-ide/codex-acp";
  const attestationUrl = `https://registry.npmjs.org/-/npm/v1/attestations/@alas-ide%2fcodex-acp@${version}`;
  const attestation = fixture().attestation;
  const lock = {
    packages: {
      "": {dependencies: {[packageName]: version}},
      [`../../private/tmp/check/node_modules/${packageName}`]: {version, integrity},
    },
  };
  assert.deepEqual(verifyInstalledPublication({
    packageName,
    version,
    expectedIntegrity: integrity,
    attestationUrl,
    attestation,
    lock,
    audit: {
      invalid: [],
      missing: [],
      verified: [{
        name: packageName,
        version,
        attestations: {url: attestationUrl, provenance: {predicateType: "https://slsa.dev/provenance/v1"}},
        attestationBundles: attestation.attestations,
      }],
    },
  }), {version, integrity});

  assert.throws(() => verifyInstalledPublication({
    packageName,
    version,
    expectedIntegrity: integrity,
    attestationUrl,
    attestation,
    lock,
    audit: {invalid: [], missing: [], verified: []},
  }), /verified.*attestation|attestation.*verified/i);

  const stale = structuredClone(lock);
  stale.packages[`../../private/tmp/check/node_modules/${packageName}`].integrity = "sha512-stale";
  assert.throws(() => verifyInstalledPublication({
    packageName,
    version,
    expectedIntegrity: integrity,
    attestationUrl,
    attestation,
    lock: stale,
    audit: {
      invalid: [],
      missing: [],
      verified: [{
        name: packageName,
        version,
        attestations: {url: attestationUrl, provenance: {predicateType: "https://slsa.dev/provenance/v1"}},
        attestationBundles: attestation.attestations,
      }],
    },
  }), /installed.*version.*integrity|version.*integrity.*installed/i);
});
