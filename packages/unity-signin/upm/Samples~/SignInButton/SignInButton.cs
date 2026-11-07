// Sample: a uGUI button that signs the player in and then calls the game backend.
//
// Setup: add this component to a GameObject, assign a Button and a Text, and set the
// URLs in the inspector. The game backend must mount the Enlitt client sign-in handler
// and the session middleware with `header: true` (see the package README).
#nullable enable

using System;
using Enlitt.SignIn;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;

namespace Enlitt.SignIn.Samples
{
    /// <summary>Signs in on click, then calls an authenticated endpoint of the game backend.</summary>
    public sealed class SignInButton : MonoBehaviour
    {
        [SerializeField] private Button button = null!;
        [SerializeField] private Text status = null!;

        [Tooltip("The client sign-in base on your backend: <appOrigin><basePath>.")]
        [SerializeField] private string backendBaseUrl = "https://game.example.com/enlitt/client";

        [Tooltip("An endpoint of your backend that uses the Enlitt session, e.g. returns the player's profile.")]
        [SerializeField] private string profileUrl = "https://game.example.com/api/profile";

        [Tooltip("Optional deep link for Android and iOS, e.g. com.example.game://signin. Must be in the server's returnUrls.")]
        [SerializeField] private string returnUrl = "";

        private EnlittSignIn? signIn;

        private void Start()
        {
            signIn = new EnlittSignIn(new EnlittSignInOptions
            {
                BackendBaseUrl = backendBaseUrl,
                ReturnUrl = returnUrl,
            });
            status.text = signIn.IsSignedIn ? "Signed in." : "Signed out.";
            button.onClick.AddListener(OnClicked);
        }

        // async void is correct here: it is a UI event handler, and every failure is shown in the label.
        private async void OnClicked()
        {
            if (signIn == null)
            {
                return;
            }

            button.interactable = false;
            try
            {
                if (!signIn.IsSignedIn)
                {
                    status.text = "Waiting for the browser...";
                    await signIn.SignInAsync();
                }

                status.text = "Signed in. Loading profile...";
                status.text = await LoadProfileAsync(signIn, profileUrl);
            }
            catch (EnlittSignInException e)
            {
                status.text = "Sign-in failed: " + e.Code;
            }
            finally
            {
                button.interactable = true;
            }
        }

        private static async System.Threading.Tasks.Task<string> LoadProfileAsync(EnlittSignIn signIn, string url)
        {
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                // Authorize adds the Enlitt-Session header; send it only to your own backend.
                signIn.Authorize(request);
                var done = new System.Threading.Tasks.TaskCompletionSource<bool>();
                request.SendWebRequest().completed += _ => done.TrySetResult(true);
                await done.Task;

                if (request.responseCode == 401)
                {
                    // The backend no longer accepts this session: forget it so the next click signs in again.
                    signIn.ForgetSession();
                    return "Session expired. Click to sign in again.";
                }

                return request.result == UnityWebRequest.Result.Success
                    ? request.downloadHandler.text
                    : "Request failed: " + request.error;
            }
        }
    }
}
