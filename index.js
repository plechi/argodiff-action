const axios = require('axios');
const core = require('@actions/core');
const yaml = require('yaml');
const _ = require('colors');
const diff = require('diff');

const argoServer = core.getInput("argocd-server") || process.env.ARGOCD_SERVER;
const revision = process.env.GITHUB_SHA;
const authToken = core.getInput("argocd-token") || process.env.ARGOCD_TOKEN;
const repositorySlug = core.getInput("repo-slug") || process.env.GITHUB_REPOSITORY;
const changelist = (core.getInput("changelist") || process.env.CHANGES).split(",").map((path) => path.trim());

const axiosInstance = axios.create({
  baseURL: argoServer,
  headers: {
    'Cookie': `argocd.token=${authToken}`
  }
});


function log(message) {
  core.info(message)
}


/**
 * Check if it's a github repository
 * @param repo
 */
function isRepository(repoUrl) {
  return repoUrl.indexOf("github.com") >= 0 &&
    repoUrl.endsWith(`${repositorySlug}.git`)
}

/**
 * Trims a path to remove any leading slashes or dots.
 * @param path
 */
function trimPath(path) {
  return path.replace(/^[\\.\/]+/g, '')
}


async function getAffectedApps(changelist) {

  changelist = changelist.map(trimPath)
  const response = await axiosInstance.get(`/api/v1/applications`, {
    params: {
      fields: [
        "items.metadata.name",
        "items.metadata.namespace",
        "items.spec"
      ].join(","),
    }
  });
  return response.data.items
    // first we filter out the applications that are not in the current repository
    .filter((app) => {
      const repos = []

      // collect all the source repos
      if (app.spec.source && app.spec.source.repoURL) {
        repos.push(app.spec.source.repoURL)
      }
      if (app.spec.sources && app.spec.sources.length > 0) {
        app.spec.sources.forEach((source) => {
          if (source.repoURL) {
            repos.push(source.repoURL)
          }
        })
      }

      // check if any of the repos are the current repository
      return repos.some((repo) => isRepository(repo))

    })
    // then we filter out the applications which don't have changes
    .filter((app) => {
      const paths = []

      // collect all the source repos
      if (app.spec.source && app.spec.source.path) {
        paths.push(app.spec.source.path)
      }
      if (app.spec.sources && app.spec.sources.length > 0) {
        app.spec.sources.forEach((source) => {
          if (source.path) {
            paths.push(source.path)
          }

        })
      }

      // look for changes in the paths of the application.
      return paths.map(trimPath)
        .some((path) => changelist.some((change) => change.startsWith(path)))
    })

}


/**
 * Get the manifests for a given application and revision.
 * @param appName the ArgoCD application name
 * @param revision
 * @return {Promise<{}>}
 */
async function getArgoManifests(appName, appNamespace, revision) {
  try {
    const response = await axiosInstance.get(
      `/api/v1/applications/${appName}/manifests`,
      {
        params: {
          revision: revision,
          appNamespace: appNamespace
        }
      }
    );
    const data = response.data['manifests'] || [];

    const manifests = {}

    data.forEach((manifest) => {
      const parsed = JSON.parse(manifest);
      const url = `${parsed.apiVersion}/${parsed.kind}/${parsed.metadata.namespace}/${parsed.metadata.name}`;
      manifests[url] = yaml.stringify(parsed);
    })

    return manifests;

  } catch (error) {
    core.setFailed(`Failed to retrieve diff: ${error.message}`);
  }
}


async function diffManifests(appName, appNamespace, targetRevision, currentRevision = null) {
  const baselineData = await getArgoManifests(appName, appNamespace, currentRevision);
  const revisionData = await getArgoManifests(appName, appNamespace, revision);

  const resources = new Set([...Object.keys(baselineData), ...Object.keys(revisionData)]);

  const diffs = {};

  resources.forEach((resource) => {
    const baseline = baselineData[resource] || '';
    const revision = revisionData[resource] || '';
    const diffLines = diff.diffLines(baseline, revision);

    diffs[resource] = {
      lineStats: {
        total: diffLines.length,
        changed: diffLines.filter((part) => part.removed || part.added).length,
        added: diffLines.filter((part) => part.added).length,
        removed: diffLines.filter((part) => part.removed).length,
      },
      differences: diffLines
    };
  });
  return diffs
}

async function printAppDiff(appName, appNamespace, targetRevision, currentRevision) {
  const diffs = await diffManifests(appName, appNamespace, revision, currentRevision);

  const fileStats = {
    unchanged: 0,
    modified: 0,
    added: 0,
    removed: 0
  }

  Object.entries(diffs).forEach((e) => {
    const [resource, diff] = e
    log(`\n${appNamespace}/${appName} - ${resource}`.bold);

    const lineStats = diff.lineStats;

    // file statistics
    if (lineStats.changed === 0) {
      fileStats.unchanged++;
    } else if (lineStats.added === lineStats.total) {
      fileStats.added++;
    } else if (lineStats.removed === lineStats.total) {
      fileStats.removed++;
    } else {
      fileStats.modified++;
    }

    if (lineStats.changed === 0) {
      log("No changes".grey);
      return;
    }

    log(`Lines: Total ${diff.lineStats.total}`)
    log(", ")
    log(`Changed ${diff.lineStats.changed}`.blue)
    log(", ")
    log(`Added ${diff.lineStats.added}`.green)
    log(", ")
    log(`Removed ${diff.lineStats.added}`.red)
    log("\n")

    const line = part.added ? part.value.green : (part.removed ? part.value.red : part.value);
    log(line + "\n")

  });
  return fileStats
}

async function main() {
  const apps = await getAffectedApps(changelist);

  apps.foreach((app) => {
    log(`Application: ${app.metadata.namespace}/${app.metadata.name}`)
  })

  const fileStats = {
    unchanged: 0,
    modified: 0,
    added: 0,
    removed: 0
  }

  const stats = await Promise.all(apps.map((app) =>
    printAppDiff(app.metadata.name, app.metadata.namespace, revision)
  ))

  stats.forEach((stat) => {
    fileStats.unchanged += stat.unchanged;
    fileStats.modified += stat.modified;
    fileStats.added += stat.added;
    fileStats.removed += stat.removed;
  });

  log("Resource summary: " + `unchanged ${fileStats.unchanged}, ` + `modified ${fileStats.modified}`.blue + `, ` + `new ${fileStats.added}`.green + `, ` + `deleted: ${fileStats.removed}`.red)
}

main().then().catch((err) => {
  core.setFailed(err.message)
});
