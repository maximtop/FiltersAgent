/**
 * The summary fields of a final synthesis must rest on what it reconciled.
 *
 * The synthesis cannot add an observation, so in an ads review a symptom it calls unresolved, or
 * residue it calls present, needs an AFTER observation it kept as remaining. Damage needs a flaw
 * the AFTER inventory still lists: once the runner has set aside every flaw the page showed
 * unchanged before the candidate, a synthesis that still reports the page regressed is answering
 * from something the inventory no longer holds. A reply that breaks one of these rules is refused
 * and repaired like any other invalid reply, and stays inconclusive if repair fails; the code never
 * rewrites a field toward a passing verdict.
 */
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import {
    CandidateVisualAdLayoutResidue,
    CandidateVisualPageIntegrity,
    CandidateVisualSymptom,
    type CandidateVisualReviewModelOutput,
} from '../types/candidate-visual-review';
import { CandidateNetworkScope } from './candidate-network-scope';
import { type SymptomKind, isBreakageSymptom } from './symptom-rubric';

/**
 * Which summary fields of one review must rest on a reconciled observation.
 */
export interface SynthesisConsistency {
    /**
     * Whether an unresolved symptom needs a remaining AFTER observation.
     */
    backedSymptom: boolean;

    /**
     * Whether present residue needs a remaining AFTER observation.
     */
    backedResidue: boolean;

    /**
     * Whether a regressed page needs a flaw the AFTER inventory still lists.
     */
    backedRegression: boolean;
}

/**
 * Decide which summary fields one review must back.
 *
 * Only an ads review is bound: in an incorrect-blocking review the residue field reports new
 * advertising from its own records. Residue of a third-party host block may stand without a
 * remaining observation, because there empty residue is reconciled not_same_symptom by rule. A
 * regressed page is bound only for a cosmetic candidate: a network or scriptlet candidate can break
 * page function no image inventory lists as a flaw.
 *
 * @param kind - Problem class driving the review.
 * @param scope - Runner-computed scope of the candidate.
 * @param candidateRule - Exact candidate rule under review.
 * @returns The fields this review must back.
 */
export function synthesisConsistency(
    kind: SymptomKind,
    scope: CandidateNetworkScope,
    candidateRule: string,
): SynthesisConsistency {
    const adsReview = !isBreakageSymptom(kind);
    return {
        backedSymptom: adsReview,
        backedResidue: adsReview && scope !== CandidateNetworkScope.ThirdPartyHostBlock,
        backedRegression: adsReview && normalizeRule(candidateRule).kind === RuleKind.Cosmetic,
    };
}

/**
 * Refuse a synthesis whose summary fields rest on nothing it reconciled.
 *
 * @param output - The normalized semantic output.
 * @param consistency - Which fields this review must back.
 * @param afterDamageCount - Flaws the AFTER inventory still lists.
 * @returns Nothing when the output is consistent.
 */
export function assertConsistentSynthesis(
    output: CandidateVisualReviewModelOutput,
    consistency: SynthesisConsistency,
    afterDamageCount: number,
): void {
    const remaining = output.remainingInstances.length;
    if (
        consistency.backedSymptom &&
        output.symptom === CandidateVisualSymptom.NotResolved &&
        remaining === 0
    ) {
        throw new Error(
            'symptom=not_resolved needs at least one AFTER observation reconciled as remaining, ' +
                'and none is: report resolved when the reporter-defined symptom is gone, or ' +
                'unclear when the evidence cannot tell.',
        );
    }
    if (
        consistency.backedResidue &&
        output.adLayoutResidue === CandidateVisualAdLayoutResidue.Present &&
        remaining === 0
    ) {
        throw new Error(
            'adLayoutResidue=present needs at least one AFTER observation reconciled as ' +
                'remaining, and none is: report absent when no residue remains, or unclear when ' +
                'the evidence cannot tell.',
        );
    }
    if (
        consistency.backedRegression &&
        output.pageIntegrity === CandidateVisualPageIntegrity.Regressed &&
        afterDamageCount === 0
    ) {
        throw new Error(
            'pageIntegrity=regressed needs a flaw the AFTER inventory lists, and it lists none: ' +
                'the runner set aside every flaw the page shows unchanged without the candidate. ' +
                'Report intact when nothing else is visibly broken, or unclear when the evidence ' +
                'cannot tell.',
        );
    }
}
