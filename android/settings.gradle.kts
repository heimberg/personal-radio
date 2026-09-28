pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "PersonalRadio"
include(":app")
// Pure Kotlin program logic, also buildable on its own: ./gradlew -p core test
includeBuild("core")
