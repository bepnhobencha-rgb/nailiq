import path from "node:path";
import { fileURLToPath } from "node:url";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const config = {
  webpack(config, { webpack }) {
    for (const name of ["presenceActions", "setupActions"]) {
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        new RegExp(`(?:^@/|[\\/]src[\\/])shared[\\/]dashboard[\\/]${name}(?:\\.ts)?$`),
        path.join(fixture, name + ".ts"),
      ));
    }
    return config;
  },
};
export default config;
