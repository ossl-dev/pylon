import { auditConfig } from '@ossl/pylon-core';
import { loadPylonConfig } from '../load-config.js';

export async function doctorAction(options: { json?: boolean } = {}): Promise<void> {
  try {
    const { config, configPath } = await loadPylonConfig();
    const report = { configPath, ...auditConfig(config) };
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.valid ? 'OK' : 'FAILED'}: ${configPath}`);
      console.log(`${report.versions.length} releases, ${report.endpoints.length} endpoints`);
      for (const error of report.errors) console.error(`Error: ${error}`);
      for (const warning of report.warnings) console.error(`Warning: ${warning}`);
    }
    if (!report.valid) process.exitCode = 1;
  } catch (error) {
    if (!options.json) throw error;
    console.log(
      JSON.stringify({
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
        versions: [],
        endpoints: [],
      }),
    );
    process.exitCode = 1;
  }
}
