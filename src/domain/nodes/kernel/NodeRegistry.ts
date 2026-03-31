import type { Node } from '@domain/nodes/kernel/Node';

export class NodeRegistry {
    private readonly nodes = new Map<string, Node>();

    register(node: Node) {
        if (this.nodes.has(node.id)) {
            throw new Error(`节点重复注册: ${node.id}`);
        }

        this.nodes.set(node.id, node);
        return node;
    }

    resolve(nodeId: string) {
        const node = this.nodes.get(nodeId);
        if (!node) {
            throw new Error(`节点不存在: ${nodeId}`);
        }

        return node;
    }
}
