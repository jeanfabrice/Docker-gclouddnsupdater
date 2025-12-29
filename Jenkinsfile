/* groovylint-disable CompileStatic, ConsecutiveBlankLines, DuplicateStringLiteral, GStringExpressionWithinString, LineLength, UnnecessaryGString */

String githubRepo = 'Docker-gclouddnsupdater'
String githubBranch = 'main'
String githubAccount = 'jeanfabrice'
String githubAccountToken = 'github-token-impersonation-token-jean-fabrice'

void sendMail( String r ) {
  subject = (r == 'SUCCESS') ? 'Jenkins build is back to normal:' : 'Build failed in Jenkins:'
  subject += ' ${JOB_NAME} #${BUILD_NUMBER}'
  body = 'See <${BUILD_URL}display/redirect>'
  if (r != 'SUCCESS') {
    body += "\n\n--------------------------\n" + currentBuild.rawBuild.getLog(500).join("\n")
  }
  withCredentials([string(credentialsId: 'jenkins-admin-email', variable: 'EMAIL')]) {
    emailext body: body, subject: subject, to: env.EMAIL
  }
}
pipeline {
  agent {
    kubernetes {
      inheritFrom 'jnlp kaniko'
    }
  }

  stages {
    stage("Build with Kaniko") {
      steps {
        checkout scm
        script {
            env.GIT_TAG = env.TAG_NAME ?: env.GIT_BRANCH.tokenize('/').last()
        }
        container(name: 'kaniko') {
          sh """
            /kaniko/executor --dockerfile Dockerfile --context dir://"\$(pwd)" --destination jeanfabrice/gclouddnsupdater:${env.GIT_TAG} --destination jeanfabrice/gclouddnsupdater:latest
          """
        }
      }
    }
  }

  post {
    failure {
      step([$class: 'GitHubCommitStatusSetter', statusResultSource: [$class: 'ConditionalStatusResultSource', results: [[$class: 'AnyBuildResult', message: 'FAILURE', state: 'FAILURE']]]])
      sendMail('FAILURE')
    }
    success {
      slackSend channel: '#jenkins', message: "Built!\n${BUILD_URL}", tokenCredentialId: 'rocketchat-token-jenkins-integration'
    }
    fixed {
      step([$class: 'GitHubCommitStatusSetter', statusResultSource: [$class: 'ConditionalStatusResultSource', results: [[$class: 'AnyBuildResult', message: 'SUCCESS', state: 'SUCCESS']]]])
      sendMail('SUCCESS')
    }
  }
}
