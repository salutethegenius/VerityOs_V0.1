import { MetaFacebookConnector, type MetaFacebookOptions } from "./meta-facebook.js";
import { ConnectorRegistry } from "./types.js";

export function createDefaultConnectorRegistry(options: MetaFacebookOptions = {}): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new MetaFacebookConnector(options));
  return registry;
}
