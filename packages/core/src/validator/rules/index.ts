import type { ValidatorRule } from '../engine.js';
import { activeFieldsRule } from './activeFields.js';
import { dependencyCycleRule } from './dependencyCycle.js';
import { dependencyRefsRule } from './dependencyRefs.js';
import { duplicateIdsRule } from './duplicateIds.js';
import { epicRefsRule } from './epicRefs.js';
import { queueDuplicateRule, queueRefsRule } from './queueRefs.js';
import { queueStatusRule } from './queueStatusRules.js';
import { queuedDependencyShippedRule } from './queuedDependencyShipped.js';
import { reviewRefsRule } from './reviewRefs.js';
import { shippedFieldsRule } from './shippedFields.js';
import { sprintEpicMembershipRule } from './sprintEpicMembership.js';

export const rules: readonly ValidatorRule[] = [
  duplicateIdsRule,
  queueRefsRule,
  queueDuplicateRule,
  epicRefsRule,
  dependencyRefsRule,
  dependencyCycleRule,
  queuedDependencyShippedRule,
  activeFieldsRule,
  shippedFieldsRule,
  reviewRefsRule,
  sprintEpicMembershipRule,
  queueStatusRule,
];
