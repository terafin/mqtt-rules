node {
   stage('Preparation') {
      git 'https://github.com/terafin/$JOB_NAME.git'
   }
   stage('Build') {
       sh 'docker build --rm=false -t "$DOCKER_USER/$JOB_NAME" .'
   }
   stage('Results') {
      sh 'docker login -u "$DOCKER_USER" -p "$DOCKER_PASS"'
      sh 'docker push $DOCKER_USER/$JOB_NAME'
   }
}
