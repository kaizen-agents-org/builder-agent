import type { SelfReviewResult } from "../types/contracts.js";
declare const DIMENSION_KEYS: string[];
export { DIMENSION_KEYS };
export declare function isReviewPassed(review: SelfReviewResult, threshold: number): boolean;
export declare function normalizeSelfReview(input: unknown, threshold: number): SelfReviewResult;
export declare function createFailedReview(message: string): SelfReviewResult;
//# sourceMappingURL=SelfReview.d.ts.map