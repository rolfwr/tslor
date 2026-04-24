import { findGitRepoRoot } from "./project";
import { openStorage, type Storage } from "./storage";
import { updateStorage } from "./indexing";
import { DebugOptions } from "./objstore";
import { normalizeAndValidatePath } from "./pathUtils";
import { FileSystem } from "./filesystem";



export async function runImportChain(fromPath: string, toPath: string, debugOptions: DebugOptions, fileSystem: FileSystem) {
    const resolvedFromPath = normalizeAndValidatePath(fromPath, "From path", false);
    const resolvedToPath = normalizeAndValidatePath(toPath, "To path", false);
    
    const repoRoot = findGitRepoRoot(resolvedFromPath);
    const repoRoot2 = findGitRepoRoot(resolvedToPath);
    if (repoRoot !== repoRoot2) {
      throw new Error('From and to paths are in different repositories');
    }

    const db = openStorage(debugOptions, true);
    await updateStorage(repoRoot, db, true, fileSystem);
    db.save();

    let node: NodeInfo | null = getImportChainDown(db, new Map(), resolvedFromPath, resolvedToPath);

    while (node) {
        console.log(node.id);
        node = pickNextNode(node);
    }
}

function pickNextNode(node: NodeInfo): NodeInfo | null {
    if (!node.down) {
        return null;
    }
    const nextNodes: NodeInfo[] = node.down.nodes;
    let best: NodeInfo | null = null;
    let score = 0;
    for (const nextNode of nextNodes) {
        if (!nextNode.down) {
            throw new Error('Expected nextNode.down to be set');
        }
        if (nextNode.down.score === null) {
            continue;
        }
        if (!best || nextNode.down.score < score) {
            best = nextNode;
            score = nextNode.down.score;
        }
    }
    return best;
}

interface Direction {
    nodes: NodeInfo[];
    score: number | null;
}

interface NodeInfo {
    id: string;
    scanning: NodeInfo | null;
    down: Direction | null;
}

function getNodeInfo(cache: Map<string, NodeInfo>, id: string): NodeInfo {
    const existing = cache.get(id);
    if (existing) {
        return existing;
    }
    
    const node: NodeInfo = {
        id,
        scanning: null,
        down: null
    }
    cache.set(id, node);
    return node;
}

function getImportChainDown(db: Storage, cache: Map<string, NodeInfo>, fromPath: string, toPath: string): NodeInfo {
    const node = getNodeInfo(cache, fromPath);

    populateDown(db, cache, node, fromPath, toPath);

    return node;
}

const failOnCycle = false;

function handleCycleDetection(node: NodeInfo): boolean {
    let cycleNode: NodeInfo | null = node;
    console.log('Cycle detected:');
    while (cycleNode) {
        console.log('  ' + cycleNode.id);
        const nextNode: NodeInfo | null = cycleNode.scanning;
        cycleNode.scanning = null;
        cycleNode = nextNode;
    }
    console.log();
    if (failOnCycle) {
        throw new Error('Cycle detected');
    }
    return false; // don't recurse
}

function processExporterNode(
    db: Storage,
    cache: Map<string, NodeInfo>,
    node: NodeInfo,
    exporter: { path: string },
    toPath: string,
    down: Direction
): void {
    const exporterNode = getNodeInfo(cache, exporter.path);
    node.scanning = exporterNode;
    populateDown(db, cache, exporterNode, exporter.path, toPath);
    node.scanning = null;
    if (!exporterNode.down) {
        console.log('Score is incomplete for ' + exporter.path);
        return;
    }
    if (exporterNode.down.score !== null) {
        down.score = (down.score ?? 0) + exporterNode.down.score;
        down.nodes.push(exporterNode);
    }
}

function populateDown(db: Storage, cache: Map<string, NodeInfo>, node: NodeInfo, fromPath: string, toPath: string): NodeInfo {
    let recurse = true;
    if (node.scanning) {
        recurse = handleCycleDetection(node);
    }

    if (node.down) {
        return node;
    }

    if (fromPath === toPath) {
        node.down = { nodes: [], score: 1 };
        return node;
    }

    const exporters = db.getExporterPathsOfImport(fromPath);
    if (recurse) {
        const down: Direction = { nodes: [], score: null };
        for (const exporter of exporters) {
            if (exporter.path === fromPath) {
                throw new Error('Expected exporter.path to be different from fromPath');
            }
            processExporterNode(db, cache, node, exporter, toPath, down);
        }
        node.down = down;
    }

    return node;
}