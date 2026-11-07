// A hand-written stand-in for the few UnityEngine members the kit uses, with Unity's real
// signatures (Unity 2021.3). It exists only so tests/UnityCompileCheck can compile the Unity layer
// without an editor. Nothing here runs: every member is a placeholder.
// Unity ships without nullable annotations, so the stub is nullable-oblivious too.
#nullable disable
#pragma warning disable CS1591 // The stub mirrors Unity's API; it is not documented here.

using System;

namespace UnityEngine
{
    public enum RuntimePlatform
    {
        WindowsEditor = 7,
        WindowsPlayer = 2,
        OSXPlayer = 1,
        LinuxPlayer = 13,
        IPhonePlayer = 8,
        Android = 11,
        WebGLPlayer = 17,
    }

    public static class Application
    {
        public static RuntimePlatform platform => RuntimePlatform.WindowsPlayer;

        public static string absoluteURL => "";

        public static event Action<string> deepLinkActivated;

        public static void OpenURL(string url)
        {
            deepLinkActivated?.Invoke(url);
        }
    }

    public static class PlayerPrefs
    {
        public static string GetString(string key, string defaultValue) => defaultValue;

        public static void SetString(string key, string value)
        {
        }

        public static void DeleteKey(string key)
        {
        }

        public static void Save()
        {
        }
    }

    public class Object
    {
    }

    public class Behaviour : Component
    {
    }

    public class Component : Object
    {
    }

    public class MonoBehaviour : Behaviour
    {
    }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class SerializeFieldAttribute : Attribute
    {
    }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class TooltipAttribute : Attribute
    {
        public TooltipAttribute(string tooltip)
        {
        }
    }

    public class AsyncOperation
    {
        public event Action<AsyncOperation> completed;

        protected void RaiseCompleted()
        {
            completed?.Invoke(this);
        }
    }
}

namespace UnityEngine.Events
{
    public delegate void UnityAction();

    public class UnityEvent
    {
        public void AddListener(UnityAction call)
        {
        }
    }
}

namespace UnityEngine.UI
{
    public class Selectable : MonoBehaviour
    {
        public bool interactable { get; set; }
    }

    public class Button : Selectable
    {
        public UnityEngine.Events.UnityEvent onClick { get; } = new UnityEngine.Events.UnityEvent();
    }

    public class Text : MonoBehaviour
    {
        public string text { get; set; } = "";
    }
}

namespace UnityEngine.Networking
{
    public class UploadHandler : IDisposable
    {
        public void Dispose()
        {
        }
    }

    public sealed class UploadHandlerRaw : UploadHandler
    {
        public UploadHandlerRaw(byte[] data)
        {
        }
    }

    public class DownloadHandler : IDisposable
    {
        public string text => "";

        public void Dispose()
        {
        }
    }

    public sealed class DownloadHandlerBuffer : DownloadHandler
    {
    }

    public class UnityWebRequestAsyncOperation : AsyncOperation
    {
    }

    public class UnityWebRequest : IDisposable
    {
        public enum Result
        {
            InProgress,
            Success,
            ConnectionError,
            ProtocolError,
            DataProcessingError,
        }

        public UnityWebRequest(string url, string method)
        {
        }

        public UploadHandler uploadHandler { get; set; }

        public DownloadHandler downloadHandler { get; set; }

        public Result result => Result.Success;

        public string error => "";

        public long responseCode => 200;

        public static UnityWebRequest Get(string uri) => new UnityWebRequest(uri, "GET");

        public void SetRequestHeader(string name, string value)
        {
        }

        public UnityWebRequestAsyncOperation SendWebRequest() => new UnityWebRequestAsyncOperation();

        public void Abort()
        {
        }

        public void Dispose()
        {
        }
    }
}
