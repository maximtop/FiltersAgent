import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceRecorder } from '../../src/tracer/trace-recorder';
import { reviewCandidateVisually } from '../../src/validator/candidate-visual-verifier';
import type { CandidateVisualVerifierOptions } from '../../src/validator/candidate-visual-evidence';
import { SingleShotResultKind, type SingleShotClient } from '../../src/pi/single-shot-types';
import type { SingleShotMessage } from '../../src/pi/single-shot-input';
import { DomCheckMeasurementStatus, type DomCheckRecord } from '../../src/types/dom-check';
import { encodePng } from '../pi/fixtures/png-image';

/**
 * Tile height of the fixture: two tiles per state stack without overlap, so the content of an AFTER
 * tile can sit only in the BEFORE tile at the same height.
 */
const TILE_HEIGHT = 1_080;

const CANDIDATE_RULE = 'example.org##.ad-slot';

/**
 * One observation an inventory stub reports.
 */
interface StubInstance {
    artifactId: string;
    landmark: string;
    description: string;
    footprint: 'blank_space' | 'visible';
}

/**
 * One flaw an inventory stub reports.
 */
interface StubDamage {
    artifactId: string;
    description: string;
}

/**
 * What an attribution stub answers for one item, or nothing to leave it open.
 */
interface StubAttribution {
    comparisonArtifactId: string;
    comparisonObservationIndex?: number;
}

/**
 * What an adjudication stub answers for every observation it is asked about.
 */
interface StubAdjudication {
    finding: 'layout' | 'residue' | 'unbound';
    domCheckIndex: number | null;
    holder: string | null;
}

/**
 * How the stubbed vision model behaves in one review.
 */
interface StubScript {
    instances: StubInstance[];
    damage: StubDamage[];
    attribute?: (itemText: string) => StubAttribution | undefined;
    adjudicate?: StubAdjudication;
    alwaysRegressed?: boolean;
}

/**
 * Parsed shape of the inventory line of a synthesis request, as far as the stub reads it.
 */
interface SynthesisInventory {
    before: { instances: unknown[] };
    after: { instances: unknown[]; observations: Array<{ observedDamage: unknown[] }> };
}

/**
 * The joined text of every message of one request.
 *
 * @param messages - The request messages.
 * @returns Their text.
 */
function requestText(messages: SingleShotMessage[]): string {
    return messages.map((message) => message.text).join('\n');
}

/**
 * A parsed reply.
 *
 * @param value - The reply value.
 * @returns The single-shot result.
 */
function parsed(value: unknown): unknown {
    return { kind: SingleShotResultKind.Parsed, value, usages: [], attempts: 1, model: 'stub' };
}

/**
 * A vision model that inventories what the script lists and synthesizes like the model the
 * benchmark caught: every AFTER observation it is shown stays remaining and counts as residue, and
 * every AFTER flaw it is shown regresses the page.
 *
 * @param script - What the stub reports and answers.
 * @returns The client and the recorder of its calls.
 */
function stubVision(script: StubScript): {
    vision: SingleShotClient;
    chat: ReturnType<typeof vi.fn>;
} {
    const chat = vi.fn(async (options: { messages: SingleShotMessage[] }) => {
        const text = requestText(options.messages);
        const hasImages = options.messages.some((message) => 'images' in message);
        if (text.includes('ITEM artifact=')) {
            const items = [...text.matchAll(/^Item (\d+) \([a-z_]+\): (.*)$/gmu)];
            return parsed({
                items: items.flatMap(([, index, itemText]) => {
                    const answer = script.attribute?.(itemText ?? '');
                    return answer === undefined
                        ? []
                        : [
                              {
                                  itemIndex: Number(index),
                                  visibleInComparison: true,
                                  comparisonArtifactId: answer.comparisonArtifactId,
                                  comparisonObservationIndex:
                                      answer.comparisonObservationIndex ?? null,
                                  rationale: 'The comparison image shows it the same.',
                              },
                          ];
                }),
            });
        }
        if (hasImages) {
            const labelled = new Set(
                [...text.matchAll(/artifact=([^;.\s]+)/gu)].map((match) => match[1]),
            );
            return parsed({
                coverageObserved: true,
                symptomScope: 'Empty advertising slots between sections.',
                instances: script.instances.filter((item) => labelled.has(item.artifactId)),
                observedDamage: script.damage.filter((item) => labelled.has(item.artifactId)),
                rationale: 'Every supplied image was inventoried.',
            });
        }
        if (text.includes('Agent DOM checks were measured')) {
            const observations = [...text.matchAll(/^Observation (\d+): /gmu)];
            return parsed({
                observations: observations.map(([, index]) => ({
                    observationIndex: Number(index),
                    ...(script.adjudicate ?? {
                        finding: 'unbound',
                        domCheckIndex: null,
                        holder: null,
                    }),
                    rationale: 'Read from the supplied checks.',
                })),
            });
        }
        const inventoryLine = text.split('\n').find((line) => line.startsWith('{"before"'));
        const inventory = JSON.parse(inventoryLine ?? '{}') as SynthesisInventory;
        const after = inventory.after.instances.length;
        const afterDamage = inventory.after.observations.reduce(
            (count, observation) => count + observation.observedDamage.length,
            0,
        );
        return parsed({
            symptom: after > 0 ? 'not_resolved' : 'resolved',
            symptomScope: 'Empty advertising slots between sections.',
            adLayoutResidue: after > 0 ? 'present' : 'absent',
            coverageComplete: true,
            beforeInventoryReconciliation: inventory.before.instances.map((_, index) => ({
                observationIndex: index + 1,
                disposition: 'same_symptom',
                rationale: 'The reporter-defined advertising slot.',
            })),
            afterInventoryReconciliation: inventory.after.instances.map((_, index) => ({
                observationIndex: index + 1,
                disposition: 'remaining',
                rationale: 'Blank space consistent with a reserved ad slot.',
            })),
            additionalBeforeInstances: [],
            additionalRemainingInstances: [],
            pageIntegrity: script.alwaysRegressed || afterDamage > 0 ? 'regressed' : 'intact',
            rationale: 'Reconciled the supplied inventory.',
            observedDamage: afterDamage > 0 ? ['A flaw the AFTER inventory lists.'] : [],
        });
    });
    return {
        vision: {
            modelId: 'vision-stub',
            structured: chat as never,
            text: async () => {
                throw new Error('not used by this suite');
            },
        },
        chat,
    };
}

/**
 * Review options over two stacked tiles per state, the BEFORE page carrying one advertising slot.
 *
 * @param root - Directory the fixture images are written to.
 * @param vision - The stubbed vision model.
 * @param domChecks - DOM checks the agent attached, if any.
 * @returns The options.
 */
function makeOptions(
    root: string,
    vision: SingleShotClient,
    domChecks?: DomCheckRecord[],
): CandidateVisualVerifierOptions {
    const image = (id: string): { id: string; path: string } => {
        const path = join(root, `${id}.png`);
        writeFileSync(
            path,
            encodePng(4, 4, () => [255, 255, 255]),
        );
        return { id, path };
    };
    const tiles = (state: string): CandidateVisualVerifierOptions['evidence']['beforeTiles'] =>
        [0, 1].map((index) => ({
            ...image(`${state}-tile-${index + 1}`),
            index,
            x: 0,
            y: index * TILE_HEIGHT,
            width: 1_920,
            height: TILE_HEIGHT,
            landmark: `${state} tile ${index + 1}`,
        }));
    return {
        candidateRule: CANDIDATE_RULE,
        validationArtifactId: 'validation-0123456789ab',
        evidence: {
            beforeViewport: image('before-viewport'),
            afterViewport: image('after-viewport'),
            beforeTiles: tiles('before'),
            afterTiles: tiles('after'),
            beforeCoverageComplete: true,
            afterCoverageComplete: true,
        },
        reporterSymptom: 'Empty advertising slots between the sections of the home page.',
        artifactsDir: root,
        vision,
        recorder: new TraceRecorder({ runId: 'settlement', issueNumber: 1, mode: 'fix' }),
        ...(domChecks === undefined ? {} : { domChecks }),
    };
}

/**
 * The advertising slot the BEFORE page shows and the candidate removes.
 */
const BEFORE_SLOT: StubInstance = {
    artifactId: 'before-tile-1',
    landmark: 'Below the masthead',
    description: 'An empty reserved advertising slot spanning the content width.',
    footprint: 'blank_space',
};

/**
 * The site's own footer graphic, which the AFTER inventory reads as a broken image.
 */
const FOOTER_GRAPHIC: StubDamage = {
    artifactId: 'after-tile-2',
    description: 'Footer, right column: a black error graphic with a cartoon character.',
};

/**
 * An ordinary gap between two sections of the AFTER page.
 */
const SECTION_GAP: StubInstance = {
    artifactId: 'after-tile-2',
    landmark: 'Between the news grid and the video section',
    description: 'A blank band between the two sections, consistent with a reserved ad slot.',
    footprint: 'blank_space',
};

/**
 * Blank space at the removed slot's own place, below the masthead.
 */
const SLOT_GAP: StubInstance = {
    artifactId: 'after-tile-1',
    landmark: 'Below the masthead',
    description: 'A blank band below the masthead where the advertising slot was.',
    footprint: 'blank_space',
};

/**
 * A DOM check naming the grid that holds the space below the masthead.
 *
 * @param after - What the check returned on the candidate page.
 * @returns The check record.
 */
function gridCheck(
    after: DomCheckRecord['after'] = {
        status: DomCheckMeasurementStatus.Measured,
        result: '{"gap":"40px","background":"rgba(0, 0, 0, 0)"}',
        truncated: false,
    },
): DomCheckRecord {
    return {
        expression:
            "(() => { const s = getComputedStyle(document.querySelector('.home-grid')); " +
            'return { gap: s.rowGap, background: s.backgroundColor }; })()',
        claim: 'The space below the masthead is the row gap of the transparent home grid.',
        before: {
            status: DomCheckMeasurementStatus.Measured,
            result: '{"gap":"40px","background":"rgba(0, 0, 0, 0)"}',
            truncated: false,
        },
        after,
    };
}

describe('reviewCandidateVisually settles what the page showed without the candidate', () => {
    let root: string;

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /**
     * Run one review over a fresh fixture.
     *
     * @param script - How the stubbed vision model behaves.
     * @param domChecks - DOM checks the agent attached, if any.
     * @returns The review result and the stub's call recorder.
     */
    async function review(script: StubScript, domChecks?: DomCheckRecord[]) {
        root = mkdtempSync(join(tmpdir(), 'candidate-visual-settlement-'));
        const { vision, chat } = stubVision(script);
        const result = await reviewCandidateVisually(makeOptions(root, vision, domChecks));
        return { ...result, chat };
    }

    it('does not count a flaw the BEFORE tile shows unchanged as candidate damage', async () => {
        const { review: result } = await review({
            instances: [BEFORE_SLOT],
            damage: [FOOTER_GRAPHIC],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
        });

        expect(result.verdict).toBe('verified');
        expect(result.pageIntegrity).toBe('intact');
        expect(result.settlement?.damage).toEqual([
            expect.objectContaining({
                artifactId: FOOTER_GRAPHIC.artifactId,
                beforeArtifactId: 'before-tile-2',
            }),
        ]);
    });

    it('keeps a flaw whose BEFORE match cites a tile outside the window', async () => {
        // The graphic sits on the second AFTER tile, so it can only be on the second BEFORE tile;
        // the first one shows another stretch of the page.
        const { review: result } = await review({
            instances: [BEFORE_SLOT],
            damage: [FOOTER_GRAPHIC],
            attribute: () => ({ comparisonArtifactId: 'before-tile-1' }),
        });

        expect(result.verdict).toBe('rejected');
        expect(result.pageIntegrity).toBe('regressed');
        expect(result.settlement?.damage).toEqual([]);
    });

    it('does not count a gap the BEFORE tile shows unchanged as residue', async () => {
        const { review: result } = await review({
            instances: [BEFORE_SLOT, SECTION_GAP],
            damage: [],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
        });

        expect(result.verdict).toBe('verified');
        expect(result.remainingInstances).toEqual([]);
        expect(result.settlement?.observations).toEqual([
            expect.objectContaining({
                ground: 'unchanged_before',
                beforeArtifactId: 'before-tile-2',
            }),
        ]);
    });

    it('keeps blank space where the BEFORE page showed the symptom', async () => {
        const { review: result } = await review({
            instances: [BEFORE_SLOT, SLOT_GAP],
            damage: [],
            attribute: () => ({
                comparisonArtifactId: 'before-tile-1',
                comparisonObservationIndex: 1,
            }),
        });

        expect(result.verdict).toBe('rejected');
        expect(result.remainingInstances).toEqual([
            expect.objectContaining({ landmark: SLOT_GAP.landmark }),
        ]);
    });

    it('never sets aside a visible observation, whatever BEFORE shows', async () => {
        const { review: result } = await review({
            instances: [
                BEFORE_SLOT,
                { ...SECTION_GAP, footprint: 'visible', description: 'An empty REKLAMA frame.' },
            ],
            damage: [],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
        });

        expect(result.verdict).toBe('rejected');
        expect(result.settlement?.observations).toEqual([]);
    });

    it('sets aside blank space at the removed slot when a DOM check names the grid holding it', async () => {
        const { review: result } = await review(
            {
                instances: [BEFORE_SLOT, SLOT_GAP],
                damage: [],
                attribute: () => ({
                    comparisonArtifactId: 'before-tile-1',
                    comparisonObservationIndex: 1,
                }),
                adjudicate: { finding: 'layout', domCheckIndex: 1, holder: '.home-grid' },
            },
            [gridCheck()],
        );

        expect(result.verdict).toBe('verified');
        expect(result.settlement?.observations).toEqual([
            expect.objectContaining({
                ground: 'dom_check_layout',
                domCheckIndex: 1,
                holder: '.home-grid',
            }),
        ]);
    });

    it('keeps blank space when the layout finding names an element the check never measured', async () => {
        const { review: result } = await review(
            {
                instances: [BEFORE_SLOT, SLOT_GAP],
                damage: [],
                adjudicate: { finding: 'layout', domCheckIndex: 1, holder: '.sidebar-track' },
            },
            [gridCheck()],
        );

        expect(result.verdict).toBe('rejected');
        expect(result.settlement?.observations).toEqual([]);
    });

    it('keeps blank space when the check failed on the candidate page', async () => {
        const { review: result } = await review(
            {
                instances: [BEFORE_SLOT, SLOT_GAP],
                damage: [],
                adjudicate: { finding: 'layout', domCheckIndex: 1, holder: '.home-grid' },
            },
            [gridCheck({ status: DomCheckMeasurementStatus.Failed, error: 'timed out' })],
        );

        expect(result.verdict).toBe('rejected');
    });

    it('refuses a regressed page once every listed flaw is set aside, and stays inconclusive', async () => {
        const { review: result, chat } = await review({
            instances: [BEFORE_SLOT],
            damage: [FOOTER_GRAPHIC],
            attribute: () => ({ comparisonArtifactId: 'before-tile-2' }),
            alwaysRegressed: true,
        });

        expect(result.verdict).toBe('inconclusive');
        const repairs = chat.mock.calls
            .map(([options]) =>
                requestText((options as { messages: SingleShotMessage[] }).messages),
            )
            .filter((text) => text.includes('pageIntegrity=regressed needs a flaw'));
        expect(repairs.length).toBeGreaterThan(0);
    });
});
