import { BaseNode } from '@domain/nodes/kernel/BaseNode';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';

export abstract class CopyTradeNode extends BaseNode<CopyTradeWorkflowState> {}
