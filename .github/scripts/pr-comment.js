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

    // Enhanced SonarQube data fetching
    let sonarIssues = [];
    let sonarMetrics = {};
    let sonarQualityGate = {};
    let sonarHotspots = [];
    let sonarDuplicatedBlocks = [];
    let sonarCoverage = {};
    let metricsError = null;

    if (
      (sonarResult === 'success' || sonarResult === 'failure') &&
      process.env.SONAR_TOKEN &&
      process.env.SONAR_HOST_URL
    ) {
      try {
        const sonarHeaders = {
          Authorization: `Bearer ${process.env.SONAR_TOKEN}`,
        };

        // 1. Fetch comprehensive metrics
        const metricsResponse = await fetch(
          `${process.env.SONAR_HOST_URL}/api/measures/component?component=${projectKey}&metricKeys=bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,sqale_rating,reliability_rating,security_rating,complexity,cognitive_complexity,lines_to_cover,uncovered_lines,branch_coverage,new_bugs,new_vulnerabilities,new_code_smells,new_coverage,new_duplicated_lines_density,alert_status,quality_gate_details`,
          { headers: sonarHeaders }
        );

        if (metricsResponse.ok) {
          const metricsData = await metricsResponse.json();
          if (metricsData.component && metricsData.component.measures) {
            metricsData.component.measures.forEach((measure) => {
              sonarMetrics[measure.metric] = measure.value;
            });
          }
        } else {
          metricsError = `Metrics API responded with status: ${metricsResponse.status}`;
        }

        // 2. Fetch quality gate status
        const qualityGateResponse = await fetch(
          `${process.env.SONAR_HOST_URL}/api/qualitygates/project_status?projectKey=${projectKey}`,
          { headers: sonarHeaders }
        );

        if (qualityGateResponse.ok) {
          const qualityGateData = await qualityGateResponse.json();
          sonarQualityGate = qualityGateData.projectStatus || {};
        }

        // 3. Fetch issues (bugs, vulnerabilities, code smells) with more details
        const issuesResponse = await fetch(
          `${process.env.SONAR_HOST_URL}/api/issues/search?componentKeys=${projectKey}&resolved=false&ps=50&s=SEVERITY&asc=false&additionalFields=rules,comments`,
          { headers: sonarHeaders }
        );

        if (issuesResponse.ok) {
          const issuesData = await issuesResponse.json();
          sonarIssues = issuesData.issues || [];
        }

        // 4. Fetch security hotspots
        const hotspotsResponse = await fetch(
          `${process.env.SONAR_HOST_URL}/api/hotspots/search?projectKey=${projectKey}&ps=20&status=TO_REVIEW`,
          { headers: sonarHeaders }
        );

        if (hotspotsResponse.ok) {
          const hotspotsData = await hotspotsResponse.json();
          sonarHotspots = hotspotsData.hotspots || [];
        }

        // 5. Fetch duplicated blocks
        const duplicationsResponse = await fetch(
          `${process.env.SONAR_HOST_URL}/api/duplications/show?key=${projectKey}`,
          { headers: sonarHeaders }
        );

        if (duplicationsResponse.ok) {
          const duplicationsData = await duplicationsResponse.json();
          sonarDuplicatedBlocks = duplicationsData.duplications || [];
        }

        // 6. Fetch coverage details
        const coverageResponse = await fetch(
          `${process.env.SONAR_HOST_URL}/api/measures/component_tree?component=${projectKey}&metricKeys=coverage,line_coverage,branch_coverage,uncovered_lines,uncovered_conditions&ps=10&s=metric&asc=false`,
          { headers: sonarHeaders }
        );

        if (coverageResponse.ok) {
          const coverageData = await coverageResponse.json();
          sonarCoverage = coverageData.components || [];
        }

      } catch (error) {
        console.log('Error fetching SonarQube data:', error.message);
        metricsError = error.message;
      }
    }

    // Build enhanced SonarQube section
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

      const getQualityGateEmoji = (status) => {
        switch (status) {
          case 'OK': return '✅';
          case 'WARN': return '⚠️';
          case 'ERROR': return '❌';
          default: return '⚪';
        }
      };

      sonarSection = '\n### 📊 SonarQube Analysis Results\n';

      if (sonarResult === 'failure') {
        sonarSection += '❌ **Analysis failed** - Check the logs for details\n\n';
      } else if (sonarResult === 'success') {
        sonarSection += '✅ **Analysis completed successfully**\n\n';
        
        // Quality Gate Status
        if (sonarQualityGate.status) {
          sonarSection += `**Quality Gate:** ${getQualityGateEmoji(sonarQualityGate.status)} **${sonarQualityGate.status}**\n\n`;
        }
      } else {
        sonarSection += '⏳ **Analysis status: ' + sonarResult + '**\n\n';
      }

      if (Object.keys(sonarMetrics).length > 0) {
        // Enhanced metrics table
        sonarSection += '**📈 Quality Metrics:**\n';
        sonarSection += '| Metric | Current | New Code | Rating |\n';
        sonarSection += '|--------|---------|----------|--------|\n';
        sonarSection += `| 🐛 Bugs | ${sonarMetrics.bugs || '0'} | ${sonarMetrics.new_bugs || '0'} | ${getRating(sonarMetrics.reliability_rating)} |\n`;
        sonarSection += `| 🔒 Vulnerabilities | ${sonarMetrics.vulnerabilities || '0'} | ${sonarMetrics.new_vulnerabilities || '0'} | ${getRating(sonarMetrics.security_rating)} |\n`;
        sonarSection += `| 🧼 Code Smells | ${sonarMetrics.code_smells || '0'} | ${sonarMetrics.new_code_smells || '0'} | ${getRating(sonarMetrics.sqale_rating)} |\n`;
        sonarSection += `| 📏 Lines of Code | ${sonarMetrics.ncloc || 'N/A'} | - | - |\n`;
        sonarSection += `| 🧪 Coverage | ${sonarMetrics.coverage ? sonarMetrics.coverage + '%' : 'N/A'} | ${sonarMetrics.new_coverage ? sonarMetrics.new_coverage + '%' : 'N/A'} | - |\n`;
        sonarSection += `| 📋 Duplicated Lines | ${sonarMetrics.duplicated_lines_density ? sonarMetrics.duplicated_lines_density + '%' : 'N/A'} | ${sonarMetrics.new_duplicated_lines_density ? sonarMetrics.new_duplicated_lines_density + '%' : 'N/A'} | - |\n`;
        sonarSection += `| 🧠 Complexity | ${sonarMetrics.complexity || 'N/A'} | - | - |\n`;
        sonarSection += `| 🔄 Cognitive Complexity | ${sonarMetrics.cognitive_complexity || 'N/A'} | - | - |\n\n`;

        // Security Hotspots
        if (sonarHotspots.length > 0) {
          sonarSection += '**🔥 Security Hotspots (To Review):**\n';
          sonarHotspots.slice(0, 5).forEach(hotspot => {
            const file = hotspot.component.split(':').pop();
            const line = hotspot.textRange ? hotspot.textRange.startLine : 'N/A';
            sonarSection += `🔍 **${hotspot.vulnerabilityProbability}** - ${hotspot.message}\n`;
            sonarSection += `📁 \`${file}\` (Line ${line})\n`;
          });
          if (sonarHotspots.length > 5) {
            sonarSection += `\n*... and ${sonarHotspots.length - 5} more hotspots*\n`;
          }
          sonarSection += '\n';
        }

        // Critical Issues
        if (sonarIssues.length > 0) {
          const criticalIssues = sonarIssues.filter(issue => 
            issue.severity === 'BLOCKER' || issue.severity === 'CRITICAL'
          );
          
          if (criticalIssues.length > 0) {
            sonarSection += '**🚨 Critical Issues:**\n';
            criticalIssues.slice(0, 5).forEach(issue => {
              const file = issue.component.split(':').pop();
              const line = issue.textRange ? issue.textRange.startLine : 'N/A';
              const rule = issue.rule ? issue.rule.split(':').pop() : 'Unknown';
              sonarSection += `${getSeverityEmoji(issue.severity)} **${issue.severity}** - ${issue.message}\n`;
              sonarSection += `📁 \`${file}\` (Line ${line}) | Rule: \`${rule}\`\n`;
            });
            if (criticalIssues.length > 5) {
              sonarSection += `\n*... and ${criticalIssues.length - 5} more critical issues*\n`;
            }
            sonarSection += '\n';
          }

          // Top Issues Summary
          const issueSummary = sonarIssues.reduce((acc, issue) => {
            acc[issue.severity] = (acc[issue.severity] || 0) + 1;
            return acc;
          }, {});

          if (Object.keys(issueSummary).length > 0) {
            sonarSection += '**📋 Issues Summary:**\n';
            Object.entries(issueSummary).forEach(([severity, count]) => {
              sonarSection += `${getSeverityEmoji(severity)} ${severity}: ${count} | `;
            });
            sonarSection = sonarSection.slice(0, -3) + '\n\n'; // Remove last " | "
          }
        }

        // Coverage Details
        if (sonarCoverage.length > 0) {
          const lowCoverageFiles = sonarCoverage.filter(comp => 
            comp.measures.some(m => m.metric === 'coverage' && parseFloat(m.value) < 80)
          );
          
          if (lowCoverageFiles.length > 0) {
            sonarSection += '**📉 Files with Low Coverage (<80%):**\n';
            lowCoverageFiles.slice(0, 5).forEach(comp => {
              const file = comp.name;
              const coverage = comp.measures.find(m => m.metric === 'coverage');
              if (coverage) {
                sonarSection += `📁 \`${file}\` - ${coverage.value}%\n`;
              }
            });
            if (lowCoverageFiles.length > 5) {
              sonarSection += `\n*... and ${lowCoverageFiles.length - 5} more files*\n`;
            }
            sonarSection += '\n';
          }
        }

        // Quality Gate Details
        if (sonarQualityGate.conditions) {
          const failedConditions = sonarQualityGate.conditions.filter(c => c.status === 'ERROR');
          if (failedConditions.length > 0) {
            sonarSection += '**❌ Failed Quality Gate Conditions:**\n';
            failedConditions.forEach(condition => {
              sonarSection += `• ${condition.metricKey}: ${condition.actualValue} (threshold: ${condition.errorThreshold})\n`;
            });
            sonarSection += '\n';
          }
        }

        sonarSection += `[📈 View Full Report](${process.env.SONAR_HOST_URL}/dashboard?id=${projectKey}) | `;
        sonarSection += `[🔍 View Issues](${process.env.SONAR_HOST_URL}/project/issues?id=${projectKey}) | `;
        sonarSection += `[🔥 View Hotspots](${process.env.SONAR_HOST_URL}/security_hotspots?id=${projectKey})`;
      } else if (metricsError) {
        sonarSection += `⚠️ **Could not fetch quality metrics**: ${metricsError}\n\n`;
        sonarSection += `[📈 View Project Dashboard](${process.env.SONAR_HOST_URL}/dashboard?id=${projectKey})`;
      } else {
        sonarSection += '⚠️ **No metrics available** - This may be the first scan or project data is not accessible.\n\n';
        sonarSection += `[📈 View Project Dashboard](${process.env.SONAR_HOST_URL}/dashboard?id=${projectKey})`;
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
