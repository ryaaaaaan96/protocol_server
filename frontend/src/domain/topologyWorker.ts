import ELK from "elkjs/lib/elk-api";
import LayoutWorker from "elkjs/lib/elk-worker.min.js?worker";

export function createLayoutEngine() {
  return new ELK({ algorithms: ["layered"], workerFactory: () => new LayoutWorker() });
}
