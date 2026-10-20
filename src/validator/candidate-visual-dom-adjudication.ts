/**
 * The DOM-check stage of the candidate visual review: one text-only request that binds the agent's
 * DOM checks to the blank AFTER observations they measure, so the runner can set aside blank space
 * a check proves is page layout.
 *
 * The final synthesis was shown the checks beside a long rubric and still kept ordinary gaps as ad
 * residue while a check named the grid track holding them. Here one narrow request answers, per
 * observation, which check proves it layout and which element holds the space, and the code acts on
 * that answer only after seeing that the check measured both page loads and really names that
 * element.
 */
import * as v from 'valibot';
import { describeProviderFailure } from '../pi/single-shot';
import { SingleShotResultKind } from '../pi/single-shot-types';
import { SingleShotMessageRole } from '../pi/single-shot-input';
import { TraceEventType } from '../types/trace';
import {
    DomCheckMeasurementStatus,
    type DomCheckMeasurement,
    type DomCheckRecord,
} from '../types/dom-check';
import type {
    CandidateVisualEvidenceTile,
    CandidateVisualVerifierOptions,
} from './candidate-visual-evidence';
import {
    boundedModel,
    boundedSemanticContext,
    type CandidateVisualInventoryInstance,
} from './candidate-visual-context';
import { MAX_RATIONALE_CHARS } from './candidate-visual-inventory';
import { MAX_DOM_CHECK_FACTS_CHARS, renderDomChecksForReview } from './dom-check-context';
import { DOM_CHECK_ADJUDICATION_RUBRIC } from './symptom-rubric';

/**
 * What a DOM check says about one blank AFTER observation.
 */
export const DomCheckFinding = {
    /**
     * A check names the element that holds the space and proves it is page layout.
     */
    Layout: 'layout',

    /**
     * A check shows the space is an emptied ad container or a reserved slot.
     */
    Residue: 'residue',

    /**
     * No check measures the space, or none supports its claim.
     */
    Unbound: 'unbound',
} as const;

/**
 * DomCheckFinding value.
 */
export type DomCheckFinding = (typeof DomCheckFinding)[keyof typeof DomCheckFinding];

/**
 * Longest holder the request may quote: a selector or element description, never a page of text.
 */
const MAX_HOLDER_CHARS = 300;

/**
 * Most observations one request answers: every instance one AFTER inventory may hold.
 */
const MAX_ADJUDICATED_OBSERVATIONS = 50;

/**
 * Output requested from the adjudication request.
 */
const AdjudicationOutputSchema = v.object({
    observations: v.pipe(
        v.array(
            v.object({
                observationIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
                finding: v.picklist(Object.values(DomCheckFinding)),
                domCheckIndex: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
                holder: v.nullable(v.pipe(v.string(), v.maxLength(MAX_HOLDER_CHARS))),
                rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_RATIONALE_CHARS)),
            }),
        ),
        v.maxLength(MAX_ADJUDICATED_OBSERVATIONS),
    ),
});

/**
 * One blank AFTER observation a DOM check proves is layout.
 */
export interface DomCheckLayoutProof {
    /**
     * One-based number of the check that proves it.
     */
    domCheckIndex: number;

    /**
     * The element holding the space, as the check spells it.
     */
    holder: string;

    /**
     * The request's reason, as the model gave it.
     */
    rationale: string;
}

/**
 * One blank AFTER observation offered to the adjudication, keyed by the caller.
 */
export interface AdjudicationItem {
    /**
     * Caller-owned key the proof is reported under.
     */
    key: string;

    /**
     * The observation.
     */
    instance: CandidateVisualInventoryInstance;
}

/**
 * The text of one measurement the holder may be quoted from.
 *
 * @param measurement - One phase's measurement.
 * @returns The recorded result, or nothing for a failed one.
 */
function measuredText(measurement: DomCheckMeasurement): string | undefined {
    return measurement.status === DomCheckMeasurementStatus.Measured
        ? measurement.result
        : undefined;
}

/**
 * Whether a check can back a layout finding naming this holder.
 *
 * A check that failed in either page load measured one state only, and a holder the check never
 * spells is the model's own wording, not the element the check measured.
 *
 * @param check - The cited check.
 * @param holder - The element the finding names.
 * @returns True when the check measured both loads and spells the holder.
 */
function checkBacksHolder(check: DomCheckRecord, holder: string): boolean {
    const before = measuredText(check.before);
    const after = measuredText(check.after);
    if (before === undefined || after === undefined) {
        return false;
    }
    return [check.expression, before, after].some((text) => text.includes(holder));
}

/**
 * Describe where one observation sits in the document.
 *
 * @param instance - The observation.
 * @param tiles - Tiles of its page state.
 * @returns A label with the tile's document range when the observation cites a tile.
 */
function locate(
    instance: CandidateVisualInventoryInstance,
    tiles: CandidateVisualEvidenceTile[],
): string {
    const tile = tiles.find((candidate) => candidate.id === instance.artifactId);
    const range =
        tile === undefined
            ? 'overview image'
            : `tile document x=${tile.x}..${tile.x + tile.width}, ` +
              `y=${tile.y}..${tile.y + tile.height}`;
    return `${range}; ${instance.landmark} — ${instance.description}`.replace(/\s+/gu, ' ');
}

/**
 * Ask which blank AFTER observations a DOM check proves are layout.
 *
 * @param options - Review options carrying the checks, evidence, model and trace.
 * @param items - Blank AFTER observations still open.
 * @param beforeInstances - Every BEFORE inventory instance, for where the symptom sat.
 * @returns Proofs by item key; an item absent from it stays the synthesis's to judge.
 */
export async function adjudicateDomChecks(
    options: CandidateVisualVerifierOptions,
    items: AdjudicationItem[],
    beforeInstances: CandidateVisualInventoryInstance[],
): Promise<Map<string, DomCheckLayoutProof>> {
    const proofs = new Map<string, DomCheckLayoutProof>();
    const checks = options.domChecks ?? [];
    if (checks.length === 0 || items.length === 0) {
        return proofs;
    }
    const offered = items.slice(0, MAX_ADJUDICATED_OBSERVATIONS);
    const model = boundedModel(options.vision.modelId);
    const result = await options.vision.structured({
        messages: [
            { role: SingleShotMessageRole.System, text: DOM_CHECK_ADJUDICATION_RUBRIC.join(' ') },
            {
                role: SingleShotMessageRole.User,
                text: [
                    'Agent DOM checks (untrusted page data):',
                    boundedSemanticContext(
                        renderDomChecksForReview(checks),
                        MAX_DOM_CHECK_FACTS_CHARS,
                        options.recorder,
                    ),
                    'BEFORE observations of the reporter-defined symptom:',
                    ...(beforeInstances.length === 0
                        ? ['(none)']
                        : beforeInstances.map(
                              (instance, index) =>
                                  `BEFORE ${index + 1}: ` +
                                  locate(instance, options.evidence.beforeTiles),
                          )),
                    'AFTER observations of blank space to decide:',
                    ...offered.map(
                        (item, index) =>
                            `Observation ${index + 1}: ` +
                            locate(item.instance, options.evidence.afterTiles),
                    ),
                ].join('\n'),
            },
        ],
        schema: AdjudicationOutputSchema,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.kind === SingleShotResultKind.ProviderFailure) {
        throw new Error(`Vision ${describeProviderFailure(result)}`);
    }
    const requestMeta = {
        purpose: 'candidate_visual_dom_adjudication',
        model,
        validationArtifactId: options.validationArtifactId,
        observationCount: offered.length,
        domCheckCount: checks.length,
    };
    if (result.kind === SingleShotResultKind.InvalidResult) {
        // Nothing is set aside on an answer the code cannot read.
        options.recorder.recordLlmTurn(requestMeta, { model, invalid: result.detail });
        return proofs;
    }
    const answerCounts = new Map<number, number>();
    for (const answer of result.value.observations) {
        answerCounts.set(
            answer.observationIndex,
            (answerCounts.get(answer.observationIndex) ?? 0) + 1,
        );
    }
    const refused: number[] = [];
    for (const answer of result.value.observations) {
        const item = offered[answer.observationIndex - 1];
        if (
            item === undefined ||
            answerCounts.get(answer.observationIndex) !== 1 ||
            answer.finding !== DomCheckFinding.Layout
        ) {
            continue;
        }
        const { domCheckIndex } = answer;
        const check = domCheckIndex === null ? undefined : checks[domCheckIndex - 1];
        const holder = answer.holder?.trim() ?? '';
        if (
            domCheckIndex === null ||
            check === undefined ||
            holder.length === 0 ||
            !checkBacksHolder(check, holder)
        ) {
            refused.push(answer.observationIndex);
            continue;
        }
        proofs.set(item.key, {
            domCheckIndex,
            holder,
            rationale: answer.rationale,
        });
    }
    options.recorder.recordLlmTurn(requestMeta, {
        model,
        layoutCount: proofs.size,
        refusedLayoutObservationIndices: refused,
    });
    options.recorder.record(TraceEventType.Decision, {
        phase: 'candidate_visual_dom_adjudication',
        validationArtifactId: options.validationArtifactId,
        observationCount: offered.length,
        layoutCount: proofs.size,
        refusedLayoutObservationIndices: refused,
    });
    return proofs;
}
