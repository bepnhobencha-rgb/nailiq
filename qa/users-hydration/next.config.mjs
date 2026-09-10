import path from "node:path";
import { fileURLToPath } from "node:url";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const config = {
  webpack(config, { webpack }) {
    for (const name of ["superadminActions", "requireSuperadminPage"]) {
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        new RegExp(`(?:^@/|[\\/]src[\\/])shared[\\/]superadmin[\\/]${name}(?:\\.ts)?$`),
        path.join(fixture, "data.ts"),
      ));
    }
    return config;
  },
};

export default config;
