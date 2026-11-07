using System.Text.RegularExpressions;

namespace Enlitt.Tests;

/// <summary>The vendored contract and the version constant stay in lockstep with their sources.</summary>
public class ContractVersionTests
{
  [Fact]
  public void EmbeddedContractEqualsTheGeneratedProtocolContractByteForByte()
  {
    byte[] generated = File.ReadAllBytes(Path.Combine(Kit.RepoRoot(), "packages", "protocol", "generated", "contract.json"));
    using Stream embedded = typeof(EnlittContract).Assembly.GetManifestResourceStream("Enlitt.contract.json")!;
    using var copy = new MemoryStream();
    embedded.CopyTo(copy);
    Assert.Equal(generated, copy.ToArray());
  }

  [Fact]
  public void ContractExposesTheApiVersionAndKnownCodes()
  {
    Assert.False(string.IsNullOrEmpty(EnlittContract.ApiVersion));
    Assert.True(EnlittContract.ErrorCodes.ContainsKey("rate_limit_exceeded"));
    Assert.Equal(EnlittContract.ApiVersion, EnlittConstants.ApiVersion);
  }

  [Fact]
  public void SdkVersionEqualsTheVersionInDirectoryBuildProps()
  {
    string props = File.ReadAllText(Path.Combine(Kit.PackageRoot(), "Directory.Build.props"));
    string version = Regex.Match(props, "<Version>([^<]+)</Version>").Groups[1].Value;
    Assert.Equal(SdkVersion.Value, version);
  }
}
