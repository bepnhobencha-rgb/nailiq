import path from "node:path";
import { fileURLToPath } from "node:url";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const config = {
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /(?:^@\/|[\/]src[\/])shared[\/]booking[\/]groupSlotRecoveryActions(?:\.ts)?$/,
      path.join(fixture, "actions.ts"),
    ));
    return config;
  },
};

export default config;
