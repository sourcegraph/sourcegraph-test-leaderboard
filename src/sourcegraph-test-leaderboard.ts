import * as sourcegraph from 'sourcegraph'
import { Subscription, from, combineLatest, Observable, throwError, of } from 'rxjs'
import { map, switchMap } from 'rxjs/operators'

// TODO(sqs): un-hardcode date
const SINCE = '2020-04-20'

export function activate(ctx: sourcegraph.ExtensionContext): void {
    const subscription = new Subscription()
    ctx.subscriptions.add(subscription)

    /* subscription.add(
        combineLatest([
            from(sourcegraph.configuration).pipe(
                map(() => sourcegraph.configuration.get<{ experimentalFeatures?: { codeInsights?: boolean } }>().value),
                map(settings => Boolean(settings.experimentalFeatures?.codeInsights)),
                filter(enabled => !enabled)
            ),
            from(sourcegraph.app.activeWindowChanges).pipe(
                filter((win): win is sourcegraph.Window => win !== undefined)
            ),
        ])
            .pipe(
                tap(([, win]) =>
                    win.showNotification(
                        'Test leaderboard is disabled: set `{"experimentalFeatures":{"codeInsights":true}}` in user settings to enable.',
                        sourcegraph.NotificationType.Warning
                    )
                )
            )
            .subscribe()
    ) */

    subscription.add(
        sourcegraph.app.registerViewProvider('testLeaderboard', {
            where: 'directory',
            provideView: ctx => {
                const { repo, rev, path } = resolveDocumentURI(ctx.viewer.directory.uri.toString())

                return getData(repo, rev, path).pipe(
                    map(data => ({
                        title: 'Test leaderboard',
                        content: [
                            {
                                kind: sourcegraph.MarkupKind.Markdown,
                                value: `Total test additions and changes (since ${SINCE}): ${
                                    data.totalTestChanges
                                }\n\n${data.byAuthor
                                    .filter(a => a.diffStat.added + a.diffStat.changed > 0)
                                    .map(
                                        ({ author, diffStat }, i) =>
                                            `1. ${author.displayName}: ${diffStat.added + diffStat.changed} ${
                                                i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ''
                                            } ${i === 0 ? '🏆🏆🏆🏆🏆🏆🏆' : ''}`
                                    )
                                    .join('\n')}\n1. ${data.byAuthor
                                    .filter(a => a.diffStat.added + a.diffStat.changed === 0)
                                    .map(a => a.author.displayName)
                                    .join(', ')}: 0️⃣`,
                            },
                        ],
                    }))
                )
            },
        })
    )
}

interface Data {
    totalTestChanges: number
    byAuthor: {
        author: Pick<GQL.IPerson, 'displayName'>
        diffStat: Pick<GQL.IDiffStat, 'added' | 'changed'>
    }[]
}

const queryGraphQL = (query: string, variables: Record<string, unknown>): Observable<GQL.IQuery> =>
    from(sourcegraph.commands.executeCommand<GQL.IGraphQLResponseRoot>('queryGraphQL', query, variables)).pipe(
        switchMap(({ data, errors }) => {
            if (errors && errors.length > 0) {
                return throwError(new Error(`GraphQL error: ${JSON.stringify(errors)}`))
            }
            if (!data) {
                return throwError(new Error('GraphQL error: no data'))
            }
            return of(data as GQL.IQuery)
        })
    )

function getData(repo: string, rev: string, dir: string): Observable<Data> {
    interface CandidateCommit {
        author: Pick<GQL.IPerson, 'displayName'>
        oid: string
    }
    const candidateCommits: Observable<CandidateCommit[]> = queryGraphQL(
        `
    query GetCommits($repo: String!, $rev: String!, $dir: String!, $after: String!) {
        repository(name: $repo) {
            commit(rev: $rev) {
                ancestors(path: $dir, after: $after) {
                    nodes {
                        oid
                        author {
                            person {
                                displayName
                            }
                        }
                    }
                }
            }
        }
    }`,
        {
            repo,
            rev,
            dir,
            after: SINCE,
        }
    ).pipe(
        map(data =>
            data.repository?.commit?.ancestors.nodes?.map(({ oid, author }) => ({
                author: author.person,
                oid: String(oid),
            }))
        ),
        switchMap(oids => (oids === undefined ? throwError(new Error('no repository or commit found')) : of(oids)))
    )

    interface RelevantCommit extends CandidateCommit {
        diffStat: Pick<GQL.IDiffStat, 'added' | 'changed'>
    }
    const relevantCommits: Observable<RelevantCommit[]> = candidateCommits.pipe(
        switchMap(commits =>
            combineLatest(
                commits.map(({ author, oid }) =>
                    queryGraphQL(
                        `
                query GetCommit($repo: String!, $base: String!, $head: String!) {
                    repository(name: $repo) {
                        comparison(base: $base, head: $head) {
                            fileDiffs {
                                nodes {
                                    mostRelevantFile {
                                        path
                                    }
                                    stat {
                                        added
                                        changed
                                        deleted
                                    }
                                }
                            }
                        }
                    }
                }`,
                        { repo, base: `${oid}~`, head: oid }
                    ).pipe(
                        map(data => {
                            const fileDiffs = data.repository?.comparison.fileDiffs.nodes || []
                            const relevantDiffs = fileDiffs.filter(
                                diff =>
                                    diff.mostRelevantFile.path.includes('test') &&
                                    !diff.mostRelevantFile.path.endsWith('.snap') &&
                                    !diff.mostRelevantFile.path.includes('testdata') &&
                                    !diff.mostRelevantFile.path.includes('golden') &&
                                    diff.stat.added + diff.stat.changed >= 2
                            )

                            // Don't let changes to (eg) generated testdata files overwhelm the
                            // calculation.
                            const MAX_PER_FILE_DIFF = 25
                            const IGNORE_THRESHOLD = 750
                            const capLargeDiffStats = ({
                                added,
                                changed,
                            }: Pick<GQL.IDiffStat, 'added' | 'changed'>): Pick<GQL.IDiffStat, 'added' | 'changed'> => {
                                const sum = added + changed
                                if (sum >= IGNORE_THRESHOLD) {
                                    return { added: 0, changed: 0 }
                                }
                                return {
                                    added: Math.min(MAX_PER_FILE_DIFF, added),
                                    changed: Math.min(MAX_PER_FILE_DIFF, changed),
                                }
                            }

                            return {
                                author,
                                oid,
                                diffStat: sumDiffStats(relevantDiffs.map(({ stat }) => capLargeDiffStats(stat))),
                            }
                        })
                    )
                )
            )
        )
    )

    return relevantCommits.pipe(
        map(relevantCommits => {
            const byAuthor = new Map<string, Data['byAuthor'][0]>()
            for (const c of relevantCommits) {
                const key = c.author.displayName
                const value = byAuthor.get(key) || { author: c.author, diffStat: { added: 0, changed: 0 } }
                value.diffStat = sumDiffStats([value.diffStat, c.diffStat])
                byAuthor.set(key, value)
            }

            return {
                totalTestChanges: relevantCommits.reduce(
                    (sum, cur) => sum + cur.diffStat.added + cur.diffStat.changed,
                    0
                ),
                byAuthor: Array.from(byAuthor.values()).sort(
                    (a, b) => b.diffStat.added + b.diffStat.changed - (a.diffStat.added + a.diffStat.changed)
                ),
            }
        })
    )
}

function sumDiffStats(diffStats: Pick<GQL.IDiffStat, 'added' | 'changed'>[]): Pick<GQL.IDiffStat, 'added' | 'changed'> {
    return diffStats.reduce((sum, stat) => ({ added: sum.added + stat.added, changed: sum.changed + stat.changed }), {
        added: 0,
        changed: 0,
    })
}

/**
 * Resolve a URI of the form git://github.com/owner/repo?rev to an absolute reference.
 */
function resolveRootURI(uri: string): { repo: string; rev: string } {
    const url = new URL(uri)
    if (url.protocol !== 'git:') {
        throw new Error(`Unsupported protocol: ${url.protocol}`)
    }
    const repo = (url.host + url.pathname).replace(/^\/*/, '')
    const rev = url.search.slice(1)
    if (!rev) {
        throw new Error('Could not determine revision')
    }
    return { repo, rev }
}

/**
 * Resolve a URI of the form git://github.com/owner/repo?rev#path to an absolute reference.
 */
export function resolveDocumentURI(uri: string): { repo: string; rev: string; path: string } {
    return {
        ...resolveRootURI(uri),
        path: new URL(uri).hash.slice(1),
    }
}
