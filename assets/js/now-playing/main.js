const V = new URL(import.meta.url).searchParams.get("v") || "0";
const { bust } = await import(`./load.js?v=${encodeURIComponent(V)}`);

const { startOrchestrator } = await import(
  bust(import.meta.url, "./orchestrator.js")
);
startOrchestrator();
