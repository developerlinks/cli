import fs from 'fs';
import path from 'path';
import fse from 'fs-extra';
import { Command } from 'commander';
import colors from 'colors/safe';
import { homedir } from 'os';
import semver from 'semver';
import { login, logout, whoami } from '@devlink/cli-auth';
import {
  log,
  Package,
  exec,
  getLatestVersion,
  getNpmLatestSemverVersion,
  constant,
} from '@devlink/cli-utils';
import packageConfig from '../package.json';

let config;
let args;

export default async function cli(): Promise<void> {
  try {
    await prepare();
    registerCommand();
  } catch (e) {
    log.error(e.message);
  }
}

function registerCommand() {
  const program = new Command();
  program.version(packageConfig.version).usage('<command> [options]');

  program
    .command('init [type]')
    .description('项目初始化')
    .option('--packagePath <packagePath>', '手动指定init包路径')
    .option('--force', '覆盖当前路径文件（谨慎使用）')
    .action(async (type, { packagePath, force }) => {
      const packageName = '@devlink/cli-init';
      const packageVersion = await getLatestVersion(packageName);
      await execCommand({ packagePath, packageName, packageVersion }, { type, force });
    });

  program
    .command('login')
    .description('登录')
    .action(async () => {
      await login();
    });

  program
    .command('whoami')
    .description('查询个人信息')
    .action(async () => {
      const userInfo = await whoami();
      log.notice('用户名', userInfo.user.username);
      log.notice('邮箱', userInfo.user.email);
      log.verbose('用户信息', userInfo);
    });

  program
    .command('logout')
    .description('登录')
    .action(async () => {
      await logout();
    });

  program
    .command('clean')
    .description('清空缓存文件')
    .option('-a, --all', '清空全部')
    .option('-d, --dep', '清空依赖文件')
    .action(options => {
      log.notice('开始清空缓存文件');
      if (options.all) {
        cleanAll();
      } else if (options.dep) {
        const depPath = path.resolve(config.cliHome, constant.DEPENDENCIES_PATH);
        if (fs.existsSync(depPath)) {
          fse.emptyDirSync(depPath);
          log.success('清空依赖文件成功', depPath);
        } else {
          log.success('文件夹不存在', depPath);
        }
      } else {
        cleanAll();
      }
    });

  program.option('--debug', '打开调试模式').parse(process.argv);

  if (args._.length < 1) {
    program.outputHelp();
    console.log();
  }
}

async function execCommand({ packagePath, packageName, packageVersion }, extraOptions) {
  let rootFile;
  try {
    if (packagePath) {
      const execPackage = new Package({
        targetPath: packagePath,
        storePath: packagePath,
        name: packageName,
        version: packageVersion,
      });
      rootFile = execPackage.getRootFilePath(true);
    } else {
      const { cliHome } = config;
      const packageDir = `${constant.DEPENDENCIES_PATH}`;
      const targetPath = path.resolve(cliHome, packageDir);
      const storePath = path.resolve(targetPath, 'node_modules');
      const initPackage = new Package({
        targetPath,
        storePath,
        name: packageName,
        version: packageVersion,
      });
      if (await initPackage.exists()) {
        log.notice('更新 package');
        await initPackage.update();
      } else {
        log.notice('安装 package');
        await initPackage.install();
      }
      rootFile = initPackage.getRootFilePath();
    }
    const _config = Object.assign({}, config, extraOptions);
    if (fs.existsSync(rootFile)) {
      const code = `const { default: init } = require('${rootFile}'); init(${JSON.stringify(
        _config,
      )});`;

      const p = exec('node', ['-e', code.replace(/\n/g, '')], { stdio: 'inherit' });
      p.on('error', e => {
        log.verbose('命令执行失败：', e);
        handleError(e);
        process.exit(1);
      });
      p.on('exit', c => {
        log.verbose('命令执行成功', c);
        process.exit(c);
      });
    } else {
      throw new Error('入口文件不存在，请重试！');
    }
  } catch (e) {
    log.error(e.message);
  }
}

function handleError(e) {
  log.error('Error', e.message);
  log.error('stack', e.stack);
  process.exit(1);
}

function cleanAll() {
  if (fs.existsSync(config.cliHome)) {
    fse.emptyDirSync(config.cliHome);
    log.success('清空全部缓存文件成功', config.cliHome);
  } else {
    log.success('文件夹不存在', config.cliHome);
  }
}

async function prepare() {
  checkPkgVersion(); // 检查当前运行版本
  checkNodeVersion(); // 检查 node 版本
  checkRoot(); // 检查是否为 root 启动
  checkUserHome(); // 检查用户主目录
  checkInputArgs(); // 检查用户输入参数
  checkEnv(); // 检查环境变量
  await checkGlobalUpdate(); // 检查工具是否需要更新
}

async function checkGlobalUpdate() {
  log.verbose('检查 @devlink/cli 最新版本');
  const currentVersion = packageConfig.version;
  const lastVersion = await getNpmLatestSemverVersion(constant.NPM_NAME, currentVersion);
  if (semver.gt(lastVersion, currentVersion)) {
    log.warn(
      colors.yellow(`请手动更新 ${constant.NPM_NAME}，当前版本：${packageConfig.version}，最新版本：${lastVersion}
                更新命令： npm install -g ${constant.NPM_NAME}`),
    );
  }
}

function checkEnv() {
  log.verbose('开始检查环境变量');
  const dotenv = require('dotenv');
  dotenv.config({
    path: path.resolve(homedir(), '.env'),
  });
  config = createCliConfig(); // 准备基础配置
  log.verbose('环境变量', config);
}

function createCliConfig() {
  const cliConfig = {
    home: homedir(),
  };
  if (process.env.CLI_HOME) {
    cliConfig['cliHome'] = path.join(homedir(), process.env.CLI_HOME);
  } else {
    cliConfig['cliHome'] = path.join(homedir(), constant.DEFAULT_CLI_HOME);
  }
  return cliConfig;
}

function checkInputArgs() {
  log.verbose('开始校验输入参数');
  const minimist = require('minimist');
  args = minimist(process.argv.slice(2)); // 解析查询参数
  checkArgs(args); // 校验参数
  log.verbose('输入参数', args);
}

function checkArgs(args) {
  if (args.debug) {
    process.env.LOG_LEVEL = 'verbose';
  } else {
    process.env.LOG_LEVEL = 'info';
  }
  log.level = process.env.LOG_LEVEL;
}

function checkUserHome() {
  if (!homedir() || !fs.existsSync(homedir())) {
    throw new Error(colors.red('当前登录用户主目录不存在！'));
  }
}

function checkRoot() {
  const rootCheck = require('root-check');
  rootCheck(colors.red('请避免使用 root 账户启动本应用'));
}

function checkNodeVersion() {
  if (!semver.gte(process.version, constant.LOWEST_NODE_VERSION)) {
    throw new Error(
      colors.red(`devlink-cli 需要安装 v${constant.LOWEST_NODE_VERSION} 以上版本的 Node.js`),
    );
  }
}

function checkPkgVersion() {
  log.success('今天又是美好的一天');
  log.success('当前运行版本', packageConfig.version);
}
