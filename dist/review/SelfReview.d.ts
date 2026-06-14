export function isReviewPassed(review: any, threshold: any): boolean;
export function normalizeSelfReview(input: any, threshold: any): {
    score: any;
    confidence: number;
    dimensions: {
        [k: string]: any;
    };
    mustFix: any[];
    shouldFix: any[];
    niceToHave: any[];
    improvementInstructions: any[];
    passed: boolean;
};
export function createFailedReview(message: any): {
    score: number;
    confidence: number;
    dimensions: {
        [k: string]: number;
    };
    mustFix: any[];
    shouldFix: never[];
    niceToHave: never[];
    improvementInstructions: never[];
    passed: boolean;
};
export const DIMENSION_KEYS: string[];
//# sourceMappingURL=SelfReview.d.ts.map