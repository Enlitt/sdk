namespace Enlitt.Tests;

/// <summary>Usage reads and the shape of the error surface.</summary>
public class UsageErrorTests
{
  [Fact]
  public async Task UsageReadsBothAvailabilities()
  {
    var handler = StubHandler.Always(200, """{"standard":{"remaining_percent":73,"limit_cap_nano_usd":"123456789012345678901234567890"},"premium":{"remaining_percent":0,"limit_cap_nano_usd":"0"},"extra":true}""");
    EnlittUsage usage = await EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default);
    Assert.Equal(new UsageAvailability(73, "123456789012345678901234567890"), usage.Standard);
    Assert.Equal(new UsageAvailability(0, "0"), usage.Premium);
    Assert.Equal(HttpMethod.Get, Assert.Single(handler.Requests).Method);
  }

  [Fact]
  public async Task UsageWithAWrongTypedKnownFieldIsMalformed()
  {
    var handler = StubHandler.Always(200, """{"standard":{"remaining_percent":"73","limit_cap_nano_usd":"1"},"premium":{"remaining_percent":0,"limit_cap_nano_usd":"0"}}""");
    EnlittException ex = await Assert.ThrowsAsync<EnlittException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default));
    Assert.Equal(EnlittException.MalformedResponse, ex.Code);
  }

  [Fact]
  public async Task ErrorCarriesTheRequestIdAndNoCredentials()
  {
    var handler = StubHandler.Always(
        401,
        """{"error":{"message":"bad key","type":"authentication_error","param":null,"code":"invalid_api_key"}}""",
        ("x-request-id", "req_abc"));
    EnlittAuthenticationException ex = await Assert.ThrowsAsync<EnlittAuthenticationException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default));
    Assert.Equal("req_abc", ex.RequestId);
    Assert.DoesNotContain(Kit.Secret, ex.ToString());
    Assert.DoesNotContain(Kit.SessionToken, ex.ToString());
  }

  [Fact]
  public async Task UnknownCodeKeepsTheRawCodeAndIsNotRetryableOn4xx()
  {
    var handler = StubHandler.Always(400, """{"error":{"message":"new","type":"invalid_request_error","param":null,"code":"brand_new_code"}}""");
    EnlittException ex = await Assert.ThrowsAsync<EnlittException>(() => EnlittSdk.UsageCoreAsync(Kit.Options(), Kit.Seams(handler), default));
    Assert.Equal("brand_new_code", ex.Code);
    Assert.False(ex.Retryable);
    Assert.False(ex.ProviderInvoked);
  }

  [Fact]
  public void ConfigurationErrorsCarryTheLocalCode()
  {
    Assert.Equal(EnlittException.ConfigurationInvalid, new EnlittConfigurationException("x").Code);
    Assert.Equal("personal_login_required", new EnlittLoginRequiredException("x").Code);
  }
}
