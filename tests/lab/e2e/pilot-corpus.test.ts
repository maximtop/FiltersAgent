import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLocalIssueSnapshot, toAgentIssueInput } from '../../../src/local/issue-snapshot';
import { normalizeRule } from '../../../src/repo/rule-normalizer';
import { loadGoldenHumanOracle, loadGoldenRunCase } from '../../../lab/e2e/golden-case';
import { extractHumanCommitFix } from '../../../lab/e2e/human-commit-reader';

const agentInputTextFragment = (value: string): string =>
    JSON.stringify(value).slice(1, -1).toLowerCase();

const EXPECTED_PILOT_CASES = {
    'money-pl-235679': {
        issueNumber: 235679,
        extensionVersion: '5.4.3.96',
        filtersBaseSha: '203b5312920118056616596bc62a19318f57d6d3',
        humanFixCommit: 'ba2dd4007fe83ead961c22dda013c5442d7456c4',
    },
    'jelonka-com-234966': {
        issueNumber: 234966,
        extensionVersion: '5.4.3.87',
        filtersBaseSha: 'a220c34e6e26ce6e473c0ba1e7a339023da4eab3',
        humanFixCommit: '506ed6894a2fe30c15bbb70e912968ac2e8536d3',
    },
    'investing-com-234128': {
        issueNumber: 234128,
        extensionVersion: '5.4.3.74',
        filtersBaseSha: 'ed2c57c0611d4b8772dd5d83d6e238f7fbe42965',
        humanFixCommit: '7566f8e7c58ead39e2f3b7eff8edae0a838358e1',
    },
    'ipaomtk-com-232888': {
        issueNumber: 232888,
        extensionVersion: '5.4.3.38',
        filtersBaseSha: '1cf1de199b1a46305062fcedf68f884d6c97eb3e',
        humanFixCommit: 'ef8a6632bbe3531bdc945ac044f082dbb3bd16c1',
    },
    'sabcsport-com-238702': {
        issueNumber: 238702,
        extensionVersion: '5.4.3.129',
        filtersBaseSha: 'efdf26d4ba04968cadaf35585e153046ee5bfb46',
        humanFixCommit: '31b801bc6aafbb6cfba732372b160d92325db5e6',
    },
    'finance-eastmoney-com-238450': {
        issueNumber: 238450,
        extensionVersion: '5.4.3.127',
        filtersBaseSha: '76e9c07253f450e812152fc3b73722a73b0a6962',
        humanFixCommit: '425045656d90c7c5d814a134c425f19c894ef6bf',
    },
    'okteve-com-234057': {
        issueNumber: 234057,
        extensionVersion: '5.4.3.70',
        filtersBaseSha: '73bbc251183fc9f0ae3ebc47475664394567be60',
        humanFixCommit: 'd14951567323fc457b9a83c6486af7affa976d4b',
    },
    'freewebnovel-com-237978': {
        issueNumber: 237978,
        extensionVersion: '5.4.3.121',
        filtersBaseSha: '7a3d1cb705d44010224745eab87646c3da826652',
        humanFixCommit: 'ec96d884457c9faabbca61e1a94c5b0cd3976eb3',
    },
    'trans-info-236843': {
        issueNumber: 236843,
        extensionVersion: '5.4.3.110',
        filtersBaseSha: 'b8d03da22233fe11cd3437bf21232f6c4dddd2ef',
        humanFixCommit: '414fd9e5f41253f9439338a1e5ed2107f9a67011',
    },
} as const;

describe('pilot golden e2e cases', () => {
    it('keep the human answer out of every case agent input', async () => {
        const workspaceRoot = process.cwd();
        for (const [caseName, expected] of Object.entries(EXPECTED_PILOT_CASES)) {
            const caseDirectory = join(workspaceRoot, 'lab', 'benchmark', 'e2e', 'cases', caseName);
            const run = loadGoldenRunCase(caseDirectory);
            const oracle = loadGoldenHumanOracle(caseDirectory);
            const humanFix = await extractHumanCommitFix(oracle.humanFixCommit);
            const snapshot = loadLocalIssueSnapshot(run.issueFile);
            const agentInput = toAgentIssueInput(snapshot);
            const agentInputSource = JSON.stringify(agentInput).toLowerCase();

            expect(run.config.issueNumber).toBe(snapshot.rawIssue.number);
            expect(run.config.issueNumber).toBe(expected.issueNumber);
            expect(run.config.filtersBaseSha).toBe(expected.filtersBaseSha);
            expect(run.config.extensionBuild.version).toBe(expected.extensionVersion);
            expect(run.config.extensionBuild.releaseTag).toBe('v5.4.3.1');
            expect(oracle.humanFixCommit).toBe(expected.humanFixCommit);
            expect(snapshot.rawIssue.state).toBe('closed');
            expect(agentInput.attachments.length).toBeGreaterThan(0);
            expect(agentInputSource).not.toContain(oracle.humanFixCommit.toLowerCase());
            expect(agentInputSource).not.toContain(oracle.humanFixCommit.slice(0, 7).toLowerCase());
            expect(humanFix.candidates.length).toBeGreaterThan(0);
            for (const candidate of humanFix.candidates) {
                const canonicalRule = normalizeRule(candidate.rule).canonical.toLowerCase();
                const canonicalSourceRule = normalizeRule(
                    candidate.sourceRule,
                ).canonical.toLowerCase();
                expect(agentInputSource).not.toContain(
                    agentInputTextFragment(candidate.rule.trim()),
                );
                expect(agentInputSource).not.toContain(
                    agentInputTextFragment(candidate.sourceRule.trim()),
                );
                expect(agentInputSource).not.toContain(agentInputTextFragment(canonicalRule));
                expect(agentInputSource).not.toContain(agentInputTextFragment(canonicalSourceRule));
            }
            expect(readFileSync(run.runConfigPath, 'utf8')).not.toContain(oracle.humanFixCommit);
        }
        // Nine sequential shallow fetches from the public AdguardFilters remote; anonymous GitHub
        // fetch latency was observed at 18–27 s each (2026-09-08), so the network-only budget
        // needs that headroom — 120 s previously timed the whole suite red under a slow network
        // even though every assertion was passing.
    }, 600_000);
});
