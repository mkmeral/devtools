import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as efs from "aws-cdk-lib/aws-efs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import * as path from "path";

export class CommunityDashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Secrets Manager ──────────────────────────────────────────────────
    const secretArn =
      process.env.GITHUB_SECRET_ARN ??
      this.node.tryGetContext("githubSecretArn");

    if (!secretArn) {
      throw new Error(
        "GITHUB_SECRET_ARN environment variable or 'githubSecretArn' CDK context must be set.\n" +
          "Create the secret first:\n" +
          '  aws secretsmanager create-secret --name strands-grafana/github-token --secret-string "ghp_xxx" --region us-east-1'
      );
    }

    const githubSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "GitHubTokenSecret",
      secretArn
    );

    // ── VPC ──────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
    });

    // ── EFS (persistent storage for metrics.db) ─────────────────────────
    const fileSystem = new efs.FileSystem(this, "MetricsFs", {
      vpc,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      encrypted: true,
    });

    const accessPoint = fileSystem.addAccessPoint("GrafanaData", {
      path: "/grafana-data",
      createAcl: {
        ownerUid: "0",
        ownerGid: "0",
        permissions: "755",
      },
      posixUser: {
        uid: "0",
        gid: "0",
      },
    });

    // ── ECS Cluster + Cloud Map namespace ───────────────────────────────
    const namespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "Namespace",
      {
        name: "community-dashboard.local",
        vpc,
      }
    );

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsights: true,
    });

    // ── Task Definition ─────────────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDef.addVolume({
      name: "metrics-data",
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
      },
    });

    fileSystem.grant(
      taskDef.taskRole,
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
      "elasticfilesystem:ClientRootAccess"
    );

    const container = taskDef.addContainer("grafana", {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../../"), {
        file: "docker/Dockerfile",
        platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "community-dashboard",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        RECOMPUTE_METRICS: "true",
      },
      secrets: {
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(githubSecret),
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "wget -qO- http://localhost:3000/api/health || exit 1",
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(120),
      },
    });

    container.addMountPoints({
      sourceVolume: "metrics-data",
      containerPath: "/var/lib/grafana/data",
      readOnly: false,
    });

    // ── Fargate Service with Cloud Map service discovery ────────────────
    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      enableExecuteCommand: true,
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: "grafana",
        containerPort: 3000,
        dnsRecordType: servicediscovery.DnsRecordType.SRV,
      },
    });

    service.connections.allowTo(fileSystem, ec2.Port.tcp(2049), "EFS access");

    // ── API Gateway HTTP API + VPC Link ─────────────────────────────────
    // No ALB needed — API Gateway connects directly to ECS via VPC Link.
    // This avoids Epoxy/Riddler flagging a public-facing Grafana instance.
    const vpcLink = new apigwv2.CfnVpcLink(this, "VpcLink", {
      name: "community-dashboard-vpc-link",
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
      securityGroupIds: [service.connections.securityGroups[0].securityGroupId],
    });

    const httpApi = new apigwv2.CfnApi(this, "HttpApi", {
      name: "community-dashboard-api",
      protocolType: "HTTP",
      description: "API Gateway for Community Dashboard (Grafana)",
    });

    // Integration: forward all requests to the Cloud Map service via VPC Link
    const integration = new apigwv2.CfnIntegration(this, "Integration", {
      apiId: httpApi.ref,
      integrationType: "HTTP_PROXY",
      integrationMethod: "ANY",
      connectionType: "VPC_LINK",
      connectionId: vpcLink.ref,
      integrationUri: service.cloudMapService!.serviceArn,
      payloadFormatVersion: "1.0",
    });

    new apigwv2.CfnRoute(this, "DefaultRoute", {
      apiId: httpApi.ref,
      routeKey: "$default",
      target: `integrations/${integration.ref}`,
    });

    const stage = new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
    });

    // Allow API Gateway VPC Link to reach the ECS service
    service.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(3000),
      "Allow API Gateway VPC Link"
    );

    // ── CloudFront ──────────────────────────────────────────────────────
    // Extract the API Gateway domain from the endpoint URL
    const apiDomain = cdk.Fn.select(
      2,
      cdk.Fn.split("/", httpApi.attrApiEndpoint)
    );

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
    });

    // ── Outputs ─────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "GrafanaUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Grafana dashboard URL (HTTPS via CloudFront)",
    });

    new cdk.CfnOutput(this, "ApiGatewayUrl", {
      value: httpApi.attrApiEndpoint,
      description: "API Gateway endpoint URL",
    });

    new cdk.CfnOutput(this, "EfsFileSystemId", {
      value: fileSystem.fileSystemId,
      description: "EFS file system ID (persistent metrics.db storage)",
    });

    new cdk.CfnOutput(this, "ClusterArn", {
      value: cluster.clusterArn,
      description: "ECS cluster ARN",
    });

    new cdk.CfnOutput(this, "CreateSecretCommand", {
      value:
        'aws secretsmanager create-secret --name strands-grafana/github-token --secret-string "ghp_xxx" --region us-east-1',
      description: "Command to create the GitHub token secret (one-time)",
    });
  }
}
