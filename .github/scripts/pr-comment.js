// .github/scripts/pr-comment.js
const { getInput, setFailed } = require('@actions/core');
const { context, getOctokit } = require('@actions/github');

async function main() {
  try {
    const token = getInput('github-token') || process.env.GITHUB_TOKEN;
    const github = getOctokit(token);

    const { owner, repo } = context.repo;
    const pr_number = context.payload.pull_request.number;

    // Get job results from environment variables
    const eslintResult = process.env.ESLINT_RESULT || 'success';
    const typescriptResult = process.env.TYPESCRIPT_RESULT || 'success';
    const testResult = process.env.TEST_RESULT || 'skipped';
    const buildResult = process.env.BUILD_RESULT || 'success';
    const securityResult = process.env.SECURITY_RESULT || 'success';
    const dockerResult = process.env.DOCKER_RESULT || 'not_started';
    const skipSecurity = process.env.SKIP_SECURITY === 'true';
    const skipDocker = process.env.SKIP_DOCKER === 'true';
    const skipBuild = process.env.SKIP_BUILD === 'true';
    const hasTests = process.env.HAS_TESTS === 'true';

    const getEmoji = (result) => {
      if (result === 'skipped') return '⏭️';
      return result === 'success' ? '✅' : result === 'failure' ? '❌' : '⚪';
    };

    // Determine core checks
    const coreChecks = [eslintResult, typescriptResult];
    if (hasTests) {
      coreChecks.push(testResult);
    }
    if (!skipBuild) {
      coreChecks.push(buildResult);
    }
    const coreChecksPassed = coreChecks.every((result) => result === 'success');

    // Get Docker result from API
    let dockerJobResult = 'not_started';
    try {
      const workflowRuns = await github.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        event: 'pull_request',
        head_sha: context.payload.pull_request.head.sha,
      });

      if (workflowRuns.data.workflow_runs.length > 0) {
        const currentRun = workflowRuns.data.workflow_runs[0];
        const jobs = await github.rest.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: currentRun.id,
        });

        const dockerJob = jobs.data.jobs.find(
          (job) => job.name === 'Docker Build & Push'
        );
        if (dockerJob) {
          dockerJobResult =
            dockerJob.conclusion || dockerJob.status || 'in_progress';
        }
      }
    } catch (error) {
      console.log('Could not fetch Docker job status:', error.message);
    }

    const finalDockerResult = dockerJobResult;
    const dockerBuildInfo = ['not_started', 'skipped'].includes(
      finalDockerResult
    )
      ? 'skipped (core checks failed)'
      : finalDockerResult;

    // Build final comment
    const comment =
      '## ⚙️ Backend Quality + Docker Pipeline Report\n\n' +
      '| Check | Status | Result |\n' +
      '|-------|--------|---------|\n' +
      '| ESLint | ' +
      getEmoji(eslintResult) +
      ' | ' +
      eslintResult +
      ' |\n' +
      '| TypeScript | ' +
      getEmoji(typescriptResult) +
      ' | ' +
      typescriptResult +
      ' |\n' +
      '| Tests | ' +
      getEmoji(testResult) +
      ' | ' +
      testResult +
      (hasTests ? '' : ' (skipped)') +
      ' |\n' +
      '| Build | ' +
      getEmoji(buildResult) +
      ' | ' +
      buildResult +
      (skipBuild ? ' (skipped)' : '') +
      ' |\n' +
      '| Security Audit | ' +
      getEmoji(securityResult) +
      ' | ' +
      securityResult +
      ' (informational) |\n' +
      '| Docker Build | ' +
      getEmoji(finalDockerResult) +
      ' | ' +
      dockerBuildInfo +
      ' |\n\n' +
      '### 📋 Status:\n' +
      (coreChecksPassed
        ? finalDockerResult === 'success'
          ? '🎉 **All checks passed and Docker image built successfully!** Ready to deploy.'
          : '✅ **Core quality checks passed.** Docker build may have been skipped or failed.'
        : '⚠️ **Core quality checks failed.** Docker build was blocked to prevent broken images.') +
      '\n### 🐳 Docker Build Policy:\n' +
      '- Docker build **only runs** if ' +
      [
        'ESLint',
        'TypeScript',
        ...(hasTests ? ['Tests'] : []),
        ...(skipBuild ? [] : ['Build']),
      ].join(', ') +
      ' checks all pass\n' +
      '- **Security audit is informational only** - it does NOT block Docker builds\n' +
      '- Failed core checks = No Docker image to prevent deploying broken code\n' +
      (skipBuild
        ? '- **Build step is skipped** - Docker builds without separate build verification\n'
        : '') +
      '\n---\n' +
      '*Pipeline report updated at: ' +
      new Date().toISOString() +
      '*';

    // Delete previous bot comments
    const comments = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: pr_number,
    });

    for (const comment of comments.data) {
      if (
        comment.user.type === 'Bot' &&
        comment.body.includes('⚙️ Backend Quality + Docker Pipeline Report')
      ) {
        await github.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: comment.id,
        });
      }
    }

    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr_number,
      body: comment,
    });

    console.log('✅ PR comment posted successfully!');
  } catch (error) {
    console.error('❌ Script failed:', error);
    setFailed(error.message);
  }
}

main();
