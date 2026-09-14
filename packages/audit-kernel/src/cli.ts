#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import type { EvidenceBundle } from "./types.js";
import { verifyExportFile, verifyLedgerEntry } from "./verify/verify.js";

const program = new Command();

program
  .name("verity-verify")
  .description(
    "Verify a VerityOS evidence bundle without access to the application database."
  )
  .version("0.2.0");

program
  .command("export")
  .argument("<bundlePath>", "Path to an evidence bundle JSON file")
  .option("--entry-hash <hash>", "Also report a single entry by hash")
  .action((bundlePath: string, opts: { entryHash?: string }) => {
    const raw = readFileSync(bundlePath, "utf8");
    const bundle = JSON.parse(raw) as EvidenceBundle;
    const result = verifyExportFile(bundlePath);
    if (opts.entryHash) {
      const entry = bundle.ledger_entries.find((e) => e.entry_hash === opts.entryHash);
      if (!entry) {
        console.error(`Entry hash not found: ${opts.entryHash}`);
        process.exit(1);
      }
      const index = bundle.ledger_entries.findIndex((e) => e.entry_hash === opts.entryHash);
      const previous = index > 0 ? bundle.ledger_entries[index - 1].entry_hash : null;
      const issues = verifyLedgerEntry(entry, previous);
      if (issues.length > 0) {
        console.error("Entry invalid:");
        for (const issue of issues) {
          console.error(`- ${issue.code}: ${issue.message}`);
        }
        process.exit(1);
      }
      console.log("Entry valid: YES");
    }
    if (!result.valid) {
      console.error("Chain valid: NO");
      for (const issue of result.issues) {
        console.error(`- ${issue.code}: ${issue.message}`);
      }
      process.exit(1);
    }
    console.log("Chain valid: YES");
    console.log(`Entries: ${bundle.manifest.entry_count}`);
    console.log(`Organization: ${bundle.manifest.organization_id}`);
    process.exit(0);
  });

program.parse();
