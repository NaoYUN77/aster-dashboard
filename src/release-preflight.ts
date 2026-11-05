import { parseArgs } from "node:util";
import { preflightRelease, ReleasePreflightError } from "./release-manifest.js";

const help = `Usage: npm run release:preflight -- \\
  --manifest <release.json> --compose-root <checkout> --policy <local-policy> \\
  --commit <40 lowercase hex> --app <registry/repo@sha256:...>
Read-only offline binding check. Exit 0 is NOT signature verification or production admission.
Use independently selected expected references; copying them from the manifest provides no independent check.`;

try {
  const { values, tokens } = parseArgs({
    options: {
      manifest: { type: "string" },
      "compose-root": { type: "string" },
      policy: { type: "string" },
      commit: { type: "string" },
      app: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
    tokens: true,
  });
  if (new Set(tokens.map((token) => token.kind === "option" ? token.name : "")).size !== tokens.length) {
    throw new ReleasePreflightError("ARGUMENTS_INVALID");
  }
  if (values.help === true && tokens.length === 1) {
    console.log(help);
  } else {
    if (values.help || !values.manifest || !values["compose-root"] || !values.policy || !values.commit
      || !values.app) {
      throw new ReleasePreflightError("ARGUMENTS_INVALID");
    }
    const result = await preflightRelease({
      manifestPath: values.manifest,
      composeRoot: values["compose-root"],
      policyPath: values.policy,
      expected: {
        sourceCommit: values.commit,
        images: { app: values.app },
      },
    });
    console.log(JSON.stringify(result));
  }
} catch (error) {
  // Never echo raw parse errors, file paths, manifest fields, policy bytes or CLI arguments.
  console.error(JSON.stringify({
    status: "offline-bindings-failed",
    code: error instanceof ReleasePreflightError ? error.code : "ARGUMENTS_OR_INTERNAL_ERROR",
    productionAdmission: "not-evaluated",
  }));
  process.exitCode = 1;
}
