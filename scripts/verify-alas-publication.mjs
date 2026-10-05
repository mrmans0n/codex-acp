import {isDeepStrictEqual} from "node:util";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const DOWNSTREAM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alas\.(0|[1-9]\d*)$/;
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const SLSA_GITHUB_WORKFLOW_V1 = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";

function requireFullCommit(value, label) {
  if (!FULL_COMMIT.test(String(value ?? ""))) {
    throw new Error(`${label} must be a full 40-character commit SHA`);
  }
}

function readDerElement(bytes, offset) {
  if (!Buffer.isBuffer(bytes) || offset < 0 || offset + 2 > bytes.length) return null;
  const tag = bytes[offset];
  const lengthByte = bytes[offset + 1];
  let length;
  let headerLength = 2;
  if ((lengthByte & 0x80) === 0) {
    length = lengthByte;
  } else {
    const lengthBytes = lengthByte & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || offset + 2 + lengthBytes > bytes.length) return null;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length * 256) + bytes[offset + 2 + index];
    }
    headerLength += lengthBytes;
  }
  const valueStart = offset + headerLength;
  const end = valueStart + length;
  if (end > bytes.length) return null;
  return {tag, valueStart, end, next: end};
}

function derChildren(bytes, start, end) {
  const result = [];
  for (let offset = start; offset < end;) {
    const element = readDerElement(bytes, offset);
    if (!element || element.end > end || element.next <= offset) return [];
    result.push(element);
    offset = element.next;
  }
  return result;
}

function decodeDerOid(bytes) {
  if (bytes.length === 0) return "";
  const first = bytes[0];
  const values = [Math.min(2, Math.floor(first / 40)), first < 80 ? first % 40 : first - 80];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = (value * 128) + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      values.push(value);
      value = 0;
    }
  }
  if (value !== 0) return "";
  return values.join(".");
}

function findDerExtensions(bytes, oid) {
  const matches = [];
  const visit = (start, end) => {
    for (const element of derChildren(bytes, start, end)) {
      if ((element.tag & 0x20) === 0) continue;
      const children = derChildren(bytes, element.valueStart, element.end);
      if (element.tag === 0x30 && children[0]?.tag === 0x06 &&
          decodeDerOid(bytes.subarray(children[0].valueStart, children[0].end)) === oid) {
        const value = children.find((child, index) => index > 0 && child.tag === 0x04);
        if (value) matches.push(bytes.subarray(value.valueStart, value.end));
      }
      visit(element.valueStart, element.end);
    }
  };
  visit(0, bytes.length);
  return matches;
}

function derString(bytes) {
  const inner = readDerElement(bytes, 0);
  if (inner && inner.next === bytes.length && [0x0c, 0x16].includes(inner.tag)) {
    return bytes.subarray(inner.valueStart, inner.end).toString("utf8");
  }
  return bytes.toString("utf8");
}

function verifyCertificateIdentity({bundle, expectedIdentity, packageName, version}) {
  const encoded = bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error(`npm provenance signer certificate is missing for ${packageName}@${version}`);
  }
  const certificate = Buffer.from(encoded, "base64");
  const issuerValues = [
    ...findDerExtensions(certificate, "1.3.6.1.4.1.57264.1.1"),
    ...findDerExtensions(certificate, "1.3.6.1.4.1.57264.1.8"),
  ].map(derString);
  if (!issuerValues.includes("https://token.actions.githubusercontent.com")) {
    throw new Error(`npm provenance OIDC issuer mismatch for ${packageName}@${version}`);
  }
  const sanExtensions = findDerExtensions(certificate, "2.5.29.17");
  const identities = sanExtensions.flatMap((extension) => {
    const sequence = readDerElement(extension, 0);
    if (!sequence || sequence.tag !== 0x30 || sequence.next !== extension.length) return [];
    return derChildren(extension, sequence.valueStart, sequence.end)
      .filter(({tag}) => tag === 0x86)
      .map(({valueStart, end}) => extension.subarray(valueStart, end).toString("utf8"));
  });
  if (identities.length !== 1 || identities[0] !== expectedIdentity) {
    throw new Error(`npm provenance signer workflow identity mismatch for ${packageName}@${version}`);
  }
}

function verifyProvenanceAttestation({
  packageName,
  version,
  sourceCommit,
  expectedIntegrity,
  expectedRepository,
  expectedWorkflowPath,
  expectedWorkflowRef,
  attestation,
}) {
  const provenance = attestation?.attestations?.filter(({predicateType}) =>
    predicateType === SLSA_PROVENANCE_V1) ?? [];
  if (provenance.length !== 1) {
    throw new Error(`npm provenance attestation count mismatch for ${packageName}@${version}`);
  }
  const bundle = provenance[0].bundle;
  if (bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" ||
      bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" ||
      typeof bundle.dsseEnvelope.payload !== "string") {
    throw new Error(`npm provenance bundle format mismatch for ${packageName}@${version}`);
  }
  verifyCertificateIdentity({
    bundle,
    expectedIdentity: `${expectedRepository}/${expectedWorkflowPath}@${expectedWorkflowRef}`,
    packageName,
    version,
  });
  let statement;
  try {
    statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  } catch {
    throw new Error(`npm provenance payload is invalid for ${packageName}@${version}`);
  }
  const integrityDigest = Buffer.from(expectedIntegrity.slice("sha512-".length), "base64").toString("hex");
  const encodedPackageName = packageName.startsWith("@") ? `%40${packageName.slice(1)}` : packageName;
  const expectedSubject = `pkg:npm/${encodedPackageName}@${version}`;
  if (statement?._type !== "https://in-toto.io/Statement/v1" ||
      statement?.predicateType !== SLSA_PROVENANCE_V1 ||
      statement?.subject?.length !== 1 ||
      statement.subject[0]?.name !== expectedSubject ||
      statement.subject[0]?.digest?.sha512 !== integrityDigest) {
    throw new Error(`npm provenance subject integrity mismatch for ${packageName}@${version}`);
  }
  const buildDefinition = statement.predicate?.buildDefinition;
  const workflow = buildDefinition?.externalParameters?.workflow;
  if (buildDefinition?.buildType !== SLSA_GITHUB_WORKFLOW_V1 ||
      workflow?.repository !== expectedRepository ||
      workflow?.path !== expectedWorkflowPath ||
      workflow?.ref !== expectedWorkflowRef) {
    throw new Error(`npm provenance workflow identity mismatch for ${packageName}@${version}`);
  }
  const expectedDependencyUri = `git+${expectedRepository}@${expectedWorkflowRef}`;
  const dependencies = buildDefinition?.resolvedDependencies;
  if (!Array.isArray(dependencies) || dependencies.length !== 1 ||
      dependencies[0]?.uri !== expectedDependencyUri ||
      dependencies[0]?.digest?.gitCommit !== sourceCommit) {
    throw new Error(`npm provenance source commit mismatch for ${packageName}@${version}`);
  }
}

export function verifyInstalledPublication({
  packageName,
  version,
  expectedIntegrity,
  attestationUrl,
  attestation,
  lock,
  audit,
}) {
  if (lock?.packages?.[""]?.dependencies?.[packageName] !== version) {
    throw new Error(`Installed root dependency does not request exact ${packageName}@${version}`);
  }
  const packageSuffix = `node_modules/${packageName}`;
  const installedMatches = Object.entries(lock?.packages ?? {})
    .filter(([path]) => path === packageSuffix || path.endsWith(`/${packageSuffix}`))
    .map(([, manifest]) => manifest);
  if (installedMatches.length !== 1 ||
      installedMatches[0]?.version !== version ||
      installedMatches[0]?.integrity !== expectedIntegrity) {
    throw new Error(`Installed package version/integrity does not exactly match ${packageName}@${version}`);
  }
  if (!Array.isArray(audit?.invalid) || !Array.isArray(audit?.missing) ||
      audit.invalid.length > 0 || audit.missing.length > 0) {
    throw new Error(`npm signature/provenance verification failed: ${JSON.stringify(audit)}`);
  }
  const verified = Array.isArray(audit?.verified)
    ? audit.verified.filter((entry) => entry?.name === packageName && entry?.version === version)
    : [];
  if (verified.length !== 1 ||
      verified[0]?.attestations?.url !== attestationUrl ||
      verified[0]?.attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1 ||
      !isDeepStrictEqual(verified[0]?.attestationBundles, attestation?.attestations)) {
    throw new Error(`npm verified attestation does not exactly match ${packageName}@${version}`);
  }
  return {version, integrity: expectedIntegrity};
}

export function verifyAlasPublication({
  packageName,
  version,
  sourceCommit,
  upstreamVersion,
  upstreamCommit,
  expectedIntegrity,
  expectedRepository,
  expectedWorkflowPath,
  expectedWorkflowRef,
  attestation,
  packument,
  tagCommit,
  release,
}) {
  if (typeof packageName !== "string" || packageName.length === 0) throw new Error("packageName is required");
  const versionMatch = DOWNSTREAM_VERSION.exec(String(version ?? ""));
  if (!versionMatch) throw new Error(`version is not an Alas downstream version: ${version}`);
  const versionUpstream = `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`;
  if (versionUpstream !== upstreamVersion) {
    throw new Error(`downstream version ${version} does not match upstream version ${upstreamVersion}`);
  }
  requireFullCommit(sourceCommit, "sourceCommit");
  requireFullCommit(upstreamCommit, "upstreamCommit");
  if (typeof expectedIntegrity !== "string" || !expectedIntegrity.startsWith("sha512-")) {
    throw new Error("expected integrity must be a sha512 value");
  }

  if (packument?.["dist-tags"]?.latest !== version) {
    throw new Error(`npm latest mismatch: expected ${version}, got ${packument?.["dist-tags"]?.latest}`);
  }
  const manifest = packument?.versions?.[version];
  if (!manifest || manifest.version !== version || manifest.name !== packageName) {
    throw new Error(`npm exact version metadata mismatch for ${packageName}@${version}`);
  }
  if (manifest.dist?.integrity !== expectedIntegrity) {
    throw new Error(`npm dist.integrity mismatch for ${packageName}@${version}`);
  }
  const expectedDownstream = {upstreamVersion, upstreamCommit, sourceCommit};
  for (const [field, expected] of Object.entries(expectedDownstream)) {
    if (manifest.alasDownstream?.[field] !== expected) {
      throw new Error(`npm alasDownstream.${field} mismatch for ${packageName}@${version}`);
    }
  }
  const attestations = manifest.dist?.attestations;
  if (typeof attestations?.url !== "string" || attestations.url.length === 0) {
    throw new Error(`npm dist.attestations are missing for ${packageName}@${version}`);
  }
  let attestationUrl;
  try {
    attestationUrl = new URL(attestations.url);
  } catch {
    throw new Error(`npm attestation URL mismatch for ${packageName}@${version}`);
  }
  const attestationPrefix = "/-/npm/v1/attestations/";
  const attestationSubject = attestationUrl.pathname.startsWith(attestationPrefix)
    ? decodeURIComponent(attestationUrl.pathname.slice(attestationPrefix.length))
    : "";
  if (attestationUrl.origin !== "https://registry.npmjs.org" ||
      attestationSubject !== `${packageName}@${version}`) {
    throw new Error(`npm attestation URL mismatch for ${packageName}@${version}`);
  }
  if (attestations.provenance?.predicateType !== SLSA_PROVENANCE_V1) {
    throw new Error(`npm provenance predicate mismatch for ${packageName}@${version}`);
  }
  verifyProvenanceAttestation({
    packageName,
    version,
    sourceCommit,
    expectedIntegrity,
    expectedRepository,
    expectedWorkflowPath,
    expectedWorkflowRef,
    attestation,
  });

  const tag = `alas-v${version}`;
  if (tagCommit !== sourceCommit) {
    throw new Error(`immutable tag ${tag} commit mismatch: expected ${sourceCommit}, got ${tagCommit}`);
  }
  if (release?.tagName !== tag || release.name !== tag) {
    throw new Error(`GitHub release version mismatch for ${tag}`);
  }
  if (release.targetCommitish !== sourceCommit) {
    throw new Error(`GitHub release target mismatch for ${tag}`);
  }
  if (release.isDraft || release.isPrerelease) {
    throw new Error(`GitHub release ${tag} must be final and published`);
  }

  return {
    version,
    integrity: expectedIntegrity,
    sourceCommit,
    tag,
    attestationUrl: attestations.url,
  };
}
