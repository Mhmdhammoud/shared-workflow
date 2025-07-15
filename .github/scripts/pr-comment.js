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
    const buildResult = process.env.BUILD_RESULT || 'success';
    const securityResult = process.env.SECURITY_RESULT || 'success';
    const sonarResult = process.env.SONAR_RESULT || 'success';
    const dockerResult = process.env.DOCKER_RESULT || 'not_started';
    const projectKey = process.env.PROJECT_KEY || repo.replace('/', '-');
    const skipSonar = process.env.SKIP_SONAR === 'true';
    const skipSecurity = process.env.SKIP_SECURITY === 'true';
    const skipDocker = process.env.SKIP_DOCKER === 'true';
    const skipBuild = process.env.SKIP_BUILD === 'true';

    const getEmoji = (result) => {
      if (result === 'skipped') return '⏭️';
      return result === 'success' ? '✅' : result === 'failure' ? '❌' : '⚪';
    };

    const getSeverityEmoji = (severity) => {
      switch (severity.toLowerCase()) {
        case 'blocker':
          return '🚫';
        case 'critical':
          return '🔴';
        case 'major':
          return '🟠';
        case 'minor':
          return '🟡';
        case 'info':
          return 'ℹ️';
        default:
          return '⚪';
      }
    };

    // Determine core checks
    const coreChecks = [eslintResult, typescriptResult];
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

    // Fetch SonarQube data
    let sonarIssues = [];
    let sonarMetrics = {};
    let metricsError = null;

    if (
      (sonarResult === 'success' || sonarResult === 'failure') &&
      process.env.SONAR_TOKEN &&
      process.env.SONAR_HOST_URL
    ) {
      try {
        const metricsResponse = await fetch(
          `${process.env.SONAR_HOST_URL}/api/measures/component?component=${projectKey}&metricKeys=bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,sqale_rating,reliability_rating,security_rating`,
          {
            headers: {
              Authorization: `Bearer ${process.env.SONAR_TOKEN}`,
            },
          }
        );

        if (metricsResponse.ok) {
          const metricsData = await metricsResponse.json();
          if (metricsData.component && metricsData.component.measures) {
            metricsData.component.measures.forEach((measure) => {
              sonarMetrics[measure.metric] = measure.value;
            });
          }
        } else {
          metricsError = `API responded with status: ${metricsResponse.status}`;
        }

        if (Object.keys(sonarMetrics).length > 0) {
          const issuesResponse = await fetch(
            `${process.env.SONAR_HOST_URL}/api/issues/search?componentKeys=${projectKey}&resolved=false&ps=20&s=SEVERITY&asc=false`,
            {
              headers: {
                Authorization: `Bearer ${process.env.SONAR_TOKEN}`,
              },
            }
          );

          if (issuesResponse.ok) {
            const issuesData = await issuesResponse.json();
            sonarIssues = issuesData.issues || [];
          }
        }
      } catch (error) {
        console.log('Error fetching SonarQube data:', error.message);
        metricsError = error.message;
      }
    }

    // Build SonarQube section
    let sonarSection = '';
    if (sonarResult !== 'skipped' && !skipSonar) {
      const getRating = (rating) => {
        const ratings = {
          '1.0': 'A',
          '2.0': 'B',
          '3.0': 'C',
          '4.0': 'D',
          '5.0': 'E',
        };
        return ratings[rating] || rating;
      };

      sonarSection = '\n### 📊 SonarQube Analysis Results\n';

      if (sonarResult === 'failure') {
        sonarSection +=
          '❌ **Analysis failed** - Check the logs for details\n\n';

        if (Object.keys(sonarMetrics).length > 0) {
          sonarSection +=
            '**Quality Metrics (from previous successful scan):**\n';
          sonarSection += '| Metric | Value | Rating |\n';
          sonarSection += '|--------|-------|---------|\n';
          sonarSection +=
            '| 🐛 Bugs | ' +
            (sonarMetrics.bugs || '0') +
            ' | ' +
            getRating(sonarMetrics.reliability_rating) +
            ' |\n';
          sonarSection +=
            '| 🔒 Vulnerabilities | ' +
            (sonarMetrics.vulnerabilities || '0') +
            ' | ' +
            getRating(sonarMetrics.security_rating) +
            ' |\n';
          sonarSection +=
            '| 🧼 Code Smells | ' +
            (sonarMetrics.code_smells || '0') +
            ' | ' +
            getRating(sonarMetrics.sqale_rating) +
            ' |\n';
          sonarSection +=
            '| 📏 Lines of Code | ' +
            (sonarMetrics.ncloc || 'N/A') +
            ' | - |\n';
          sonarSection +=
            '| 🧪 Coverage | ' +
            (sonarMetrics.coverage ? sonarMetrics.coverage + '%' : 'N/A') +
            ' | - |\n';
          sonarSection +=
            '| 📋 Duplicated Lines | ' +
            (sonarMetrics.duplicated_lines_density
              ? sonarMetrics.duplicated_lines_density + '%'
              : 'N/A') +
            ' | - |\n\n';
          sonarSection +=
            '[📈 View Project Dashboard](' +
            process.env.SONAR_HOST_URL +
            '/dashboard?id=' +
            projectKey +
            ')';
        } else if (metricsError) {
          sonarSection +=
            '⚠️ **Could not fetch quality metrics**: ' + metricsError + '\n\n';
          sonarSection +=
            '[📈 View Project Dashboard](' +
            process.env.SONAR_HOST_URL +
            '/dashboard?id=' +
            projectKey +
            ')';
        } else {
          sonarSection +=
            '⚠️ **No metrics available** - This may be the first scan or project data is not accessible.\n\n';
          sonarSection +=
            '[📈 View Project Dashboard](' +
            process.env.SONAR_HOST_URL +
            '/dashboard?id=' +
            projectKey +
            ')';
        }
      } else if (sonarResult === 'success') {
        sonarSection += '✅ **Analysis completed successfully**\n\n';

        if (Object.keys(sonarMetrics).length > 0) {
          sonarSection += '**Quality Metrics:**\n';
          sonarSection += '| Metric | Value | Rating |\n';
          sonarSection += '|--------|-------|---------|\n';
          sonarSection +=
            '| 🐛 Bugs | ' +
            (sonarMetrics.bugs || '0') +
            ' | ' +
            getRating(sonarMetrics.reliability_rating) +
            ' |\n';
          sonarSection +=
            '| 🔒 Vulnerabilities | ' +
            (sonarMetrics.vulnerabilities || '0') +
            ' | ' +
            getRating(sonarMetrics.security_rating) +
            ' |\n';
          sonarSection +=
            '| 🧼 Code Smells | ' +
            (sonarMetrics.code_smells || '0') +
            ' | ' +
            getRating(sonarMetrics.sqale_rating) +
            ' |\n';
          sonarSection +=
            '| 📏 Lines of Code | ' +
            (sonarMetrics.ncloc || 'N/A') +
            ' | - |\n';
          sonarSection +=
            '| 🧪 Coverage | ' +
            (sonarMetrics.coverage ? sonarMetrics.coverage + '%' : 'N/A') +
            ' | - |\n';
          sonarSection +=
            '| 📋 Duplicated Lines | ' +
            (sonarMetrics.duplicated_lines_density
              ? sonarMetrics.duplicated_lines_density + '%'
              : 'N/A') +
            ' | - |\n\n';

          if (sonarIssues.length > 0) {
            sonarSection += '**Top Issues Found:**\n';
            for (let i = 0; i < Math.min(10, sonarIssues.length); i++) {
              const issue = sonarIssues[i];
              const line = issue.textRange ? issue.textRange.startLine : 'N/A';
              const file = issue.component.split(':').pop();
              sonarSection +=
                getSeverityEmoji(issue.severity) +
                ' **' +
                issue.severity +
                '** - ' +
                issue.message +
                '  \n';
              sonarSection += '📁 `' + file + '` (Line ' + line + ')\n';
            }
            if (sonarIssues.length > 10) {
              sonarSection +=
                '\n*... and ' + (sonarIssues.length - 10) + ' more issues*\n';
            }
            sonarSection +=
              '\n[📈 View Full Report](' +
              process.env.SONAR_HOST_URL +
              '/dashboard?id=' +
              projectKey +
              ')';
          } else {
            sonarSection += '✅ **No issues found!**\n\n';
            sonarSection +=
              '[📈 View Full Report](' +
              process.env.SONAR_HOST_URL +
              '/dashboard?id=' +
              projectKey +
              ')';
          }
        } else {
          if (metricsError) {
            sonarSection +=
              '⚠️ **Could not fetch detailed metrics**: ' +
              metricsError +
              '\n\n';
          } else {
            sonarSection +=
              '⚠️ **No detailed metrics available** - This may be the first scan.\n\n';
          }
          sonarSection +=
            '[📈 View Full Report](' +
            process.env.SONAR_HOST_URL +
            '/dashboard?id=' +
            projectKey +
            ')';
        }
      } else {
        sonarSection += '⏳ **Analysis status: ' + sonarResult + '**\n\n';
        sonarSection +=
          '[📈 View Project Dashboard](' +
          process.env.SONAR_HOST_URL +
          '/dashboard?id=' +
          projectKey +
          ')';
      }
    }

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
      '| SonarQube Analysis | ' +
      getEmoji(sonarResult) +
      ' | ' +
      sonarResult +
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
      sonarSection +
      '\n### 🐳 Docker Build Policy:\n' +
      '- Docker build **only runs** if ' +
      (skipBuild ? 'ESLint and TypeScript' : 'ESLint, TypeScript, and Build') +
      ' checks all pass\n' +
      '- **SonarQube and Security audits are informational only** - they do NOT block Docker builds\n' +
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
