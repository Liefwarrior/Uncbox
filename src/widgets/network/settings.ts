export type NetworkSettings = {
  /** The host (or host:port) to ping, or '' for the default. */
  pingTarget: string;
  /** Also show the ping to this PC's router. */
  showRouter: boolean;
};

export const defaultNetworkSettings = (): NetworkSettings => ({ pingTarget: '', showRouter: true });
