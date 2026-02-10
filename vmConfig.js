require('dotenv').config();

const launchParams = {
  InstanceCount: 1,
  InstanceType: process.env.INSTANCE_TYPE,  // e.g. S5.MEDIUM4
  ImageId: process.env.IMAGE_ID,            // your base image
  InstanceChargeType: "SPOTPAID",   
  Placement: {
    Zone: process.env.ZONE                  // e.g. ap-singapore-2
  },
  VirtualPrivateCloud: {
    VpcId: process.env.VPC_ID,
    SubnetId: process.env.SUBNET_ID
  },
  InternetAccessible: {
    InternetChargeType: "TRAFFIC_POSTPAID_BY_HOUR",
    InternetMaxBandwidthOut: 20,
    PublicIpAssigned: true
  },
  SecurityGroupIds: [process.env.SG_ID]
};

module.exports = launchParams;
