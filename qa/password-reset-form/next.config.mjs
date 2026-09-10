import path from "node:path";
import { fileURLToPath } from "node:url";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const config = {
  // Standalone test app: never loaded by NailIQ's production configuration.
  webpack(config, { webpack }) {
    for (const [module, replacement] of [
      ["auth/emailPasswordAuth", "email-password-action.ts"],
      ["register/actions", "magic-link-action.ts"],
      ["lib/supabase/client", "supabase-client.ts"],
    ]) {
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        new RegExp(`(?:^@/|[/\\\\]src[/\\\\])shared[/\\\\]${module.split("/").join("[/\\\\]")}(?:\\.ts)?$`),
        path.join(fixture, replacement),
      ));
    }
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /(?:^@\/|[\\/]src[\\/])shared[\\/]auth[\\/]salonOwnerAuth(?:\.ts)?$/,
      path.join(fixture, "action.ts"),
    ));
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /(?:^@\/|[\\/]src[\\/])shared[\\/]superadmin[\\/]superadminAuth(?:\.ts)?$/,
      path.join(fixture, "superadmin-action.ts"),
    ));
    return config;
  },
};
export default config;
