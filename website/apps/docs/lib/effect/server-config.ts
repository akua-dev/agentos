import { ConfigProvider, Layer } from 'effect';

/** Reads the host environment only while an Effect Layer is being built. */
export const LiveServerConfig = Layer.suspend(() =>
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);
