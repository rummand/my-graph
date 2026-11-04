/**
 * Connectors: accounts that bring outside content (calendar links, a mailbox, later Aula and more) into one graph,
 * as one person. Server-only. See the Aula and connectors proposal: typed manifests, per-stream cursors committed
 * with the data, one reset path, "needs you" vs "will retry" with back-off, secrets encrypted at rest, and everything
 * derived proposed as change sets for a person to deliver.
 */
export {
  connectionsNeedingYou, createConnection, disconnect, getConnection, importedCount, listConnections, runNow, updateConnection,
  ConnectionError, type ConnectionDTO, type RunDTO, type ConnectionStatusView,
} from "./store";
export { connectorById, connectorInfo, offeredIn, CONNECTORS, type ConnectorInfo } from "./registry";
export { startConnectorScheduler, stopConnectorScheduler, tick as connectorTick } from "./run";
