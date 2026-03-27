import { BaseNode } from '../kernel/BaseNode';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';

export abstract class CopyTradeNode extends BaseNode<CopyTradeWorkflowState> {}
